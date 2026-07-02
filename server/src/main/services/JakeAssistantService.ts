import { injectable } from "tsyringe";
import { RealEstateApiDao } from "../data/RealEstateApiDao.ts";
import { GhlApiClient } from "../ghlEnrichment/api/GhlApiClient.ts";
import { GhlConnectionService } from "../ghlEnrichment/connections/GhlConnectionService.ts";
import { GhlConnection } from "../ghlEnrichment/connections/GhlConnectionTypes.ts";
import { JakeGatewayClient } from "../ghlEnrichment/gateway/JakeGatewayClient.ts";
import { CreditService } from "../ghlEnrichment/metering/CreditService.ts";
import { TextJakeCustomerService } from "../ghlEnrichment/customers/TextJakeCustomerService.ts";
import { normalizeInboundAddress } from "../util/address.ts";
import { JakeInboundMessage, JakeInboundResult, JakeTextMode } from "../types/Jake.ts";
import { RealEstateApiPropertySearchResult } from "../types/RealEstateApi.ts";
import { PropertyReportWriter } from "./PropertyReportWriter.ts";
import {
    AbsenteeStatus,
    EquityLevel,
    OccupancyStatus,
    PropertyReportData,
} from "../types/PropertyReport.ts";

/**
 * A resolved transport for one inbound text: which mode handled it and the two
 * verbs the flow needs, already bound to the right client + (for own_number)
 * location. This is how mode-selection stays out of the core flow below.
 */
interface TextRoute {
    mode: JakeTextMode;
    /** Send the SMS reply. */
    send(contactId: string, message: string): Promise<unknown>;
    /** Write a status note on the customer's contact. */
    note(contactId: string, body: string): Promise<unknown>;
}

const GUIDANCE_REPLY =
    "Hi! Text me a full property address (e.g. \"123 Main St, Springfield, IL 62704\") " +
    "and I'll pull up what I can find.";

const OUT_OF_CREDITS_REPLY =
    "You're out of Jake credits, so I couldn't run that lookup. Top up and text the address again.";

@injectable()
export class JakeAssistantService {
    constructor(
        private readonly realEstateDao: RealEstateApiDao,
        private readonly ghlClient: GhlApiClient,
        private readonly gateway: JakeGatewayClient,
        private readonly connections: GhlConnectionService,
        private readonly customers: TextJakeCustomerService,
        private readonly credits: CreditService,
        private readonly reportWriter: PropertyReportWriter
    ) {}

    /**
     * Core text-Jake path (JAK-115), MODE-AWARE:
     *   1. resolve the texting CUSTOMER by sender phone (the billing identity —
     *      both modes); upsert a Postgres record + its credit account (JAK-109).
     *   2. resolve the text MODE: if an active connection owns this inbound and is
     *      set to 'own_number', run inside THAT customer's own GHL sub-account on
     *      their per-tenant key + number (the JAK-114 path). Otherwise 'gateway':
     *      run through Zequi's shared Jake sub-account on the master gateway key.
     *   3. parse the address; no address → guidance reply, no charge.
     *   4. credit gate — never look up for free; out of credits → notice + note.
     *   5. look up the property, reply over the chosen transport.
     *   6. charge the customer's credits only when a match was delivered.
     *   7. write a status note on the contact (both modes).
     *
     * Cross-tenant isolation holds: own_number only ever sends/notes on the
     * resolved connection's own creds + a number proven to be its own; the gateway
     * path never touches a tenant key; and each customer bills only their own
     * phone/credits.
     */
    public async handleInboundMessage(input: JakeInboundMessage): Promise<JakeInboundResult> {
        // 1. Billing identity — the texting customer, keyed by sender phone.
        const customer = await this.customers.resolveByPhone(input.senderPhone, input.contactId);
        const accountId = customer.creditAccountId;

        // 2. Mode + transport.
        const route = await this.resolveRoute(input);

        const address = normalizeInboundAddress(input.message);

        // 3. No address → guidance, no lookup, no charge.
        if (!address) {
            await route.send(input.contactId, GUIDANCE_REPLY);
            await this.writeStatusNote(
                route,
                input.contactId,
                "Jake (text): message had no address — sent usage guidance."
            );
            return { ok: true, address: null, reply: GUIDANCE_REPLY, mode: route.mode, charged: 0 };
        }

        // 4. Credit gate — never look up for free.
        if (!(await this.credits.hasCreditsForTextLookup(accountId))) {
            await route.send(input.contactId, OUT_OF_CREDITS_REPLY);
            await this.writeStatusNote(
                route,
                input.contactId,
                `Jake (text): out of credits — skipped lookup for "${address}".`
            );
            return {
                ok: false,
                address,
                reply: OUT_OF_CREDITS_REPLY,
                mode: route.mode,
                charged: 0,
                outOfCredits: true,
            };
        }

        // 5. Look up the property and reply.
        let property: RealEstateApiPropertySearchResult | null;
        try {
            property = await this.realEstateDao.searchPropertyByAddress(address);
        } catch (err) {
            const reply = `Sorry — I hit a snag looking up "${address}". Please try again shortly.`;
            await route.send(input.contactId, reply);
            await this.writeStatusNote(
                route,
                input.contactId,
                `Jake (text): lookup FAILED for "${address}" (${this.errorSummary(err)}).`
            );
            return { ok: false, address, reply, mode: route.mode, charged: 0 };
        }

        const reply = await this.buildReply(address, property);
        await route.send(input.contactId, reply);

        // 6. Charge only when a match was delivered — mirrors the enrichment
        //    worker's "no match, no charge" policy (the lookup cost is ours).
        let charged = 0;
        if (property) {
            const charge = await this.credits.chargeForTextLookup({ accountId });
            charged = charge.ok ? this.credits.costOfTextLookup() : 0;
        }

        // 7. Status note on the contact.
        await this.writeStatusNote(
            route,
            input.contactId,
            property
                ? `Jake (text): looked up "${address}" — charged ${charged} credit(s).`
                : `Jake (text): no property match for "${address}" — no charge.`
        );

        return { ok: true, address, reply, mode: route.mode, charged };
    }

    /**
     * Resolve the transport for this inbound. own_number when an ACTIVE connection
     * owns the message (by location id or destination number) AND is set to
     * text_mode='own_number'; gateway otherwise (the default — including tier-1
     * customers with no connection at all). Never falls back to another tenant's
     * creds: a non-own_number/unknown/inactive connection uses the shared gateway.
     */
    private async resolveRoute(input: JakeInboundMessage): Promise<TextRoute> {
        const conn = await this.resolveOwnNumberConnection(input);
        if (conn) {
            // Only reply from a number PROVEN to belong to this connection; else
            // omit it so GHL uses the location default (never an attacker-supplied
            // number). This is the JAK-114 reply-from safety, preserved.
            const replyFrom = (input.candidateNumbers ?? [])
                .map((n) => (n ? String(n).trim() : ""))
                .find((n) => n.length > 0 && conn.phoneNumbers.includes(n));
            return {
                mode: "own_number",
                send: (contactId, message) =>
                    this.ghlClient.sendSms(conn.locationId, {
                        contactId,
                        message,
                        fromNumber: replyFrom || undefined,
                    }),
                note: (contactId, body) => this.ghlClient.createNote(conn.locationId, contactId, body),
            };
        }

        return {
            mode: "gateway",
            send: (contactId, message) => this.gateway.sendSms({ contactId, message }),
            note: (contactId, body) => this.gateway.createContactNote(contactId, body),
        };
    }

    /**
     * Find the connection that should handle this text in own_number mode, or null
     * to fall through to the gateway. Prefers the explicit location id, then a
     * destination number match. Returns null unless the connection is active AND
     * opted into own_number.
     */
    private async resolveOwnNumberConnection(
        input: JakeInboundMessage
    ): Promise<GhlConnection | null> {
        let conn: GhlConnection | null = null;

        const loc = input.locationId ? String(input.locationId).trim() : "";
        if (loc) {
            conn = await this.connections.getByLocationId(loc);
        }
        if (!conn) {
            for (const raw of input.candidateNumbers ?? []) {
                const num = raw ? String(raw).trim() : "";
                if (!num) continue;
                conn = await this.connections.getByPhoneNumber(num);
                if (conn) break;
            }
        }

        if (!conn) return null;
        if (conn.status !== "active") return null;
        if (conn.textMode !== "own_number") return null;
        return conn;
    }

    /**
     * Write a status note, swallowing failures: a note is best-effort telemetry on
     * the contact — it must never break the reply the customer already received.
     */
    private async writeStatusNote(route: TextRoute, contactId: string, body: string): Promise<void> {
        try {
            await route.note(contactId, body);
        } catch (err) {
            console.error("⚠️ Jake status note failed:", this.errorSummary(err));
        }
    }

    /** A short, secret-free description of an error for logs/notes. */
    private errorSummary(err: unknown): string {
        return err instanceof Error ? err.message : "unknown error";
    }

    /**
     * Build the customer's reply (JAK-130). No match → a deterministic, emoji-free
     * "try again" line (never the LLM). Otherwise: assemble the VERIFIED property
     * data (only fields the API returned + our derived ones) and hand it to the
     * {@link PropertyReportWriter}, which has the LLM write a "Jake Property Report"
     * SMS — falling back to a deterministic plain-text report if OpenAI is down.
     */
    private async buildReply(
        address: string,
        property: RealEstateApiPropertySearchResult | null
    ): Promise<string> {
        if (!property) {
            return `I couldn't find property info for "${address}". Double-check the address and try again.`;
        }
        return this.reportWriter.write(this.assembleReportData(property, address));
    }

    /**
     * Map a raw PropertySearch summary into the clean, verified {@link PropertyReportData}
     * the writer consumes. Only present values are set (missing → left undefined,
     * never null/blank), and the derived fields (lot acres, equity level, occupancy,
     * absentee status, years owned, free-&-clear) are computed here from the raw
     * data per JAK-130's derivation rules.
     */
    private assembleReportData(
        property: RealEstateApiPropertySearchResult,
        address: string
    ): PropertyReportData {
        const data: PropertyReportData = {};

        const { street, tail } = this.addressParts(property);
        if (street) data.addressLine1 = street;
        if (tail) data.addressLine2 = tail;
        if (!street && !tail && address.trim()) data.addressLine1 = address.trim();

        const propertyType = this.text(property.propertyType);
        if (propertyType) data.propertyType = propertyType;
        if (property.bedrooms != null) data.bedrooms = property.bedrooms;
        if (property.bathrooms != null) data.bathrooms = property.bathrooms;
        if (property.squareFeet != null) data.squareFeet = property.squareFeet;
        const lot = property.lotSquareFeet;
        if (lot != null && lot > 0) data.lotAcres = Number((lot / 43560).toFixed(2));
        if (property.yearBuilt != null) data.yearBuilt = property.yearBuilt;

        if (property.estimatedValue != null) data.estimatedMarketValue = property.estimatedValue;

        const owner1 = this.owner1Name(property);
        if (owner1) data.owner1 = owner1;
        const owner2 = this.owner2Name(property);
        if (owner2) data.owner2 = owner2;
        const equityPercent = this.equityPercent(property);
        if (equityPercent != null) data.equityPercent = equityPercent;
        if (this.isFreeClear(property)) data.freeAndClear = true;
        const equityLevel = this.equityLevel(property);
        if (equityLevel) data.equityLevel = equityLevel;
        const occupancy = this.occupancy(property);
        if (occupancy) data.occupancy = occupancy;
        const absentee = this.absentee(property);
        if (absentee) data.absenteeStatus = absentee;
        const yearsOwned = this.yearsOwned(property);
        if (yearsOwned != null) data.yearsOwned = yearsOwned;

        if (property.lastSaleDate) data.lastSoldDate = this.formatDate(property.lastSaleDate);
        if (property.lastSaleAmount != null) data.salePrice = property.lastSaleAmount;

        const flood = this.text(property.floodZoneDescription);
        if (flood) data.femaFloodZone = flood;
        if (typeof property.mlsActive === "boolean") data.mlsListed = property.mlsActive;

        return data;
    }

    private addressParts(property: RealEstateApiPropertySearchResult): { street: string; tail: string } {
        const a = property.address;
        const loc = this.propertyLocation(property);
        let street = "";
        let tail = this.cityStateZip(loc.city, loc.state, loc.zip);

        if (typeof a === "string") {
            const s = a.trim();
            const idx = s.indexOf(",");
            if (idx >= 0) {
                street = s.slice(0, idx).trim();
                if (!tail) tail = s.slice(idx + 1).trim().replace(/\s+/g, " ");
            } else {
                street = s;
            }
        } else if (a && typeof a === "object") {
            street = [a.house, a.street, a.streetType].filter(Boolean).join(" ").trim();
        }

        return { street, tail };
    }

    /** Resolve city/state/zip from flat fields, falling back to the address object. */
    private propertyLocation(
        property: RealEstateApiPropertySearchResult
    ): { city?: string; state?: string; zip?: string } {
        const obj = property.address && typeof property.address === "object" ? property.address : null;
        const pick = (flat?: string | null, nested?: string | null) =>
            (flat ?? nested ?? "").toString().trim() || undefined;
        return {
            city: pick(property.city, obj?.city),
            state: pick(property.state, obj?.state),
            zip: pick(property.zip, obj?.zip),
        };
    }

    private cityStateZip(city?: string, state?: string, zip?: string): string {
        const left = (city ?? "").trim();
        const right = [state, zip].map((x) => (x ?? "").trim()).filter(Boolean).join(" ");
        return [left, right].filter(Boolean).join(", ");
    }

    private owner1Name(property: RealEstateApiPropertySearchResult): string | null {
        if (property.owner1FullName?.trim()) return property.owner1FullName.trim();
        const composed = [property.owner1FirstName, property.owner1LastName].filter(Boolean).join(" ").trim();
        return composed || null;
    }

    private owner2Name(property: RealEstateApiPropertySearchResult): string | null {
        if (property.owner2FullName?.trim()) return property.owner2FullName.trim();
        const composed = [property.owner2FirstName, property.owner2LastName].filter(Boolean).join(" ").trim();
        return composed || null;
    }

    private equityPercent(property: RealEstateApiPropertySearchResult): number | null {
        if (typeof property.equityPercent === "number") return Math.round(property.equityPercent);
        if (this.isFreeClear(property)) return 100; // free & clear implies full equity
        return null;
    }

    /** Free & Clear = no open mortgage (prefer the flag, else a zero balance). */
    private isFreeClear(property: RealEstateApiPropertySearchResult): boolean {
        if (typeof property.freeClear === "boolean") return property.freeClear;
        if (typeof property.openMortgageBalance === "number") return property.openMortgageBalance === 0;
        return false;
    }

    private equityLevel(property: RealEstateApiPropertySearchResult): EquityLevel | null {
        if (typeof property.highEquity === "boolean") return property.highEquity ? "High Equity" : "Low Equity";
        const pct = this.equityPercent(property);
        if (pct == null) return null;
        return pct >= 50 ? "High Equity" : "Low Equity";
    }

    /**
     * Owner-Occupied vs Investor-Owned — prefer the provider flag, else derive
     * from whether the owner's tax-mailing address matches the property.
     */
    private occupancy(property: RealEstateApiPropertySearchResult): OccupancyStatus | null {
        if (typeof property.ownerOccupied === "boolean") {
            return property.ownerOccupied ? "Owner-Occupied" : "Investor-Owned";
        }
        const match = this.mailingMatchesProperty(property);
        if (match == null) return null;
        return match ? "Owner-Occupied" : "Investor-Owned";
    }

    /**
     * Absentee status derived from owner mailing vs property location: a different
     * state ⇒ Out-of-State Absentee Owner, a different city ⇒ Absentee Owner.
     * Falls back to provider flags when no mailing address is available.
     */
    private absentee(property: RealEstateApiPropertySearchResult): AbsenteeStatus | null {
        const mail = property.mailAddress;
        const loc = this.propertyLocation(property);
        const norm = (s?: string | null) => (s ?? "").toString().trim().toUpperCase();

        if (mail && (mail.state || mail.city)) {
            const mState = norm(mail.state);
            const mCity = norm(mail.city);
            if (loc.state && mState && mState !== norm(loc.state)) return "Out-of-State Absentee Owner";
            if (loc.city && mCity && mCity !== norm(loc.city)) return "Absentee Owner";
            return null;
        }

        if (property.outOfStateAbsenteeOwner === true) return "Out-of-State Absentee Owner";
        if (property.absenteeOwner === true || property.inStateAbsenteeOwner === true) return "Absentee Owner";
        return null;
    }

    private mailingMatchesProperty(property: RealEstateApiPropertySearchResult): boolean | null {
        const mail = property.mailAddress;
        if (!mail || (!mail.state && !mail.city)) return null;
        const loc = this.propertyLocation(property);
        if (!loc.state && !loc.city) return null;
        const norm = (s?: string | null) => (s ?? "").toString().trim().toUpperCase();
        const sameState = mail.state && loc.state ? norm(mail.state) === norm(loc.state) : true;
        const sameCity = mail.city && loc.city ? norm(mail.city) === norm(loc.city) : true;
        return sameState && sameCity;
    }

    /** Prefer the provider's yearsOwned, else current year minus the last-sale year. */
    private yearsOwned(property: RealEstateApiPropertySearchResult): number | null {
        if (typeof property.yearsOwned === "number" && property.yearsOwned >= 0) {
            return property.yearsOwned;
        }
        const year = this.saleYear(property.lastSaleDate);
        if (year == null) return null;
        const diff = new Date().getFullYear() - year;
        return diff >= 0 ? diff : null;
    }

    /** Normalize an ISO (YYYY-MM-DD…) sale date to MM/DD/YYYY; pass others through. */
    private formatDate(raw: string): string {
        const s = raw.trim();
        const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
        return iso ? `${iso[2]}/${iso[3]}/${iso[1]}` : s;
    }

    private saleYear(raw?: string | null): number | null {
        if (!raw) return null;
        const m = String(raw).match(/(\d{4})/);
        if (!m) return null;
        const y = Number(m[1]);
        return Number.isFinite(y) ? y : null;
    }

    private text(v: unknown): string | null {
        return typeof v === "string" && v.trim() ? v.trim() : null;
    }
}
