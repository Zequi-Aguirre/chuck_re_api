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
        private readonly credits: CreditService
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

        const reply = this.buildReply(address, property);
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
     * Build a concise SMS reply from a PropertySearch summary record.
     * Every field is optional, so lines are included only when data is present.
     */
    private buildReply(
        address: string,
        property: RealEstateApiPropertySearchResult | null
    ): string {
        if (!property) {
            return `I couldn't find property info for "${address}". Double-check the address and try again.`;
        }

        const lines: string[] = [];
        lines.push(`🏠 ${this.formatAddressLine(property, address)}`);

        const facts: string[] = [];
        if (property.bedrooms != null) facts.push(`${property.bedrooms} bd`);
        if (property.bathrooms != null) facts.push(`${property.bathrooms} ba`);
        const sqft = property.squareFeet;
        if (sqft != null) facts.push(`${this.formatNumber(sqft)} sqft`);
        if (property.yearBuilt != null) facts.push(`built ${property.yearBuilt}`);
        if (facts.length) lines.push(facts.join(" • "));

        if (property.estimatedValue != null) {
            lines.push(`Est. value: ${this.formatMoney(property.estimatedValue)}`);
        }

        if (property.lastSaleAmount != null || property.lastSaleDate) {
            const amt = property.lastSaleAmount != null ? this.formatMoney(property.lastSaleAmount) : null;
            const date = property.lastSaleDate ?? null;
            const parts = [amt, date ? `on ${date}` : null].filter(Boolean).join(" ");
            if (parts) lines.push(`Last sold: ${parts}`);
        }

        const owner = this.ownerName(property);
        if (owner) lines.push(`Owner: ${owner}`);

        if (property.mlsActive === true || property.mlsStatus) {
            lines.push(`MLS: ${property.mlsStatus ?? "Active"}`);
        }

        return lines.join("\n");
    }

    private formatAddressLine(property: RealEstateApiPropertySearchResult, fallback: string): string {
        const addr = property.address;
        if (typeof addr === "string" && addr.trim()) return addr.trim();
        if (addr && typeof addr === "object") {
            const line = [addr.house, addr.street, addr.streetType].filter(Boolean).join(" ").trim();
            const tail = [addr.city, addr.state, addr.zip].filter(Boolean).join(" ").trim();
            const full = [line, tail].filter(Boolean).join(", ");
            if (full) return full;
        }
        const flatTail = [property.city, property.state, property.zip].filter(Boolean).join(" ").trim();
        return flatTail || fallback;
    }

    private ownerName(property: RealEstateApiPropertySearchResult): string | null {
        if (property.owner1FullName) return property.owner1FullName;
        const composed = [property.owner1FirstName, property.owner1LastName].filter(Boolean).join(" ").trim();
        return composed || null;
    }

    private formatNumber(n: number): string {
        return n.toLocaleString("en-US");
    }

    private formatMoney(n: number): string {
        return `$${Math.round(n).toLocaleString("en-US")}`;
    }
}
