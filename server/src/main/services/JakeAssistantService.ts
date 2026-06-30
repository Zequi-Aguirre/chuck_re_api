import { injectable } from "tsyringe";
import { RealEstateApiDao } from "../data/RealEstateApiDao.ts";
import { GhlApiDao } from "../data/GhlApiDao.ts";
import { normalizeInboundAddress } from "../util/address.ts";
import { JakeInboundMessage, JakeInboundResult } from "../types/Jake.ts";
import { RealEstateApiPropertySearchResult } from "../types/RealEstateApi.ts";

@injectable()
export class JakeAssistantService {
    constructor(
        private readonly realEstateDao: RealEstateApiDao,
        private readonly ghlDao: GhlApiDao
    ) {}

    /**
     * Core path: inbound text → validate/format address → /v2/PropertySearch →
     * build a reply → send it back via outbound SMS. No persistence, no credits.
     */
    public async handleInboundMessage(input: JakeInboundMessage): Promise<JakeInboundResult> {
        const address = normalizeInboundAddress(input.message);

        let reply: string;
        if (!address) {
            reply =
                "Hi! Text me a full property address (e.g. \"123 Main St, Springfield, IL 62704\") " +
                "and I'll pull up what I can find.";
        } else {
            const property = await this.realEstateDao.searchPropertyByAddress(address);
            reply = this.buildReply(address, property);
        }

        await this.ghlDao.sendSms({
            contactId: input.contactId,
            message: reply,
            fromNumber: input.fromNumber,
        });

        return { ok: true, address, reply };
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
