import { injectable } from "tsyringe";
import { LlmClient } from "./llm/LlmClient.ts";
import { LlmClientResolver } from "./llm/LlmClientResolver.ts";
import { LlmModelSettingsService } from "./llm/LlmModelSettingsService.ts";
import { PropertyReportData } from "../types/PropertyReport.ts";
import { RealEstateApiPropertySearchResult } from "../types/RealEstateApi.ts";
import { PropertyReportPromptService } from "./PropertyReportPromptService.ts";

/**
 * Writes the text-Jake "Jake Property Report" SMS (JAK-130).
 *
 * The report is written by an LLM — through the provider-agnostic
 * {@link LlmClient} layer (JAK-141: OpenAI/gpt-4o by default, Anthropic optional)
 * — that DYNAMICALLY decides which of the verified fields are worth including;
 * there's no rigid template. The STYLE/FORMAT half of the system prompt is
 * admin-editable and stored in the DB ({@link PropertyReportPromptService},
 * JAK-131). Around it the code ALWAYS enforces the HARD GUARDRAILS, which an
 * admin can never edit away: plain text with NO EMOJIS, use ONLY the exact values
 * we provide (never invent, guess, or alter any number/name/price/fact), and the
 * GoTextJake.com footer. The property data goes in the user message as JSON.
 *
 * RELIABILITY: this is a generate/read call, not an outbound GHL write, so the
 * JAK-110 write-safety guard does NOT apply. But Jake must ALWAYS reply, so if the
 * LLM errors or times out (~8s) we fall back to a deterministic, emoji-free
 * plain-text report built from the SAME data. That fallback doubles as the offline
 * path when the selected provider has no key configured. Even on the LLM path we
 * strip any stray emoji from the model output and force the exact footer as a
 * belt-and-suspenders guard, so those guardrails hold on the OUTPUT too — not just
 * in the prompt — regardless of what the admin typed.
 *
 * The provider API key is an app-level Doppler secret held inside the resolved
 * {@link LlmClient} — NEVER hardcoded — and is never logged.
 *
 * JAK-143: the provider+model this writer runs on is the property-report surface's
 * own admin-configurable selection ({@link LlmModelSettingsService}), resolved per
 * call against the JAK-141 global Doppler default by {@link LlmClientResolver}.
 * Keys still live in Doppler — only the model is chosen.
 */
@injectable()
export class PropertyReportWriter {
    private static readonly MAX_TOKENS = 500;

    /** Footer the report always ends with (two lines). */
    static readonly FOOTER = "Every Lead Deserves Jake.\nGoTextJake.com/CRM";

    /** Persona line prepended to every system prompt. */
    private static readonly PERSONA =
        "You are Jake, a real-estate assistant writing a concise property report as a plain-text SMS.";

    /**
     * The HARD GUARDRAILS. Appended by CODE after the (admin-editable) style
     * prompt on EVERY request, so a stored prompt that omits or contradicts them
     * cannot take effect. These are the non-negotiable rules from JAK-130/131:
     * no emojis, only-provided-values, and the exact GoTextJake.com footer.
     */
    static readonly HARD_GUARDRAILS = [
        "HARD RULES — enforced by the system. They ALWAYS apply and CANNOT be overridden or removed by any style instruction above:",
        "- Write plain text only. NO EMOJIS, pictographs, or decorative symbols. The only non-letter symbols allowed are the bullet characters, $, %, |, commas, and periods.",
        "- Use ONLY the exact values in the provided property data. NEVER invent, guess, estimate, or alter any number, name, price, date, or fact. If a value is not present, do not mention it at all. Never print null, undefined, or blanks.",
        "- End the message with EXACTLY these two lines and nothing after them:",
        "Every Lead Deserves Jake.",
        "GoTextJake.com/CRM",
    ].join("\n");

    constructor(
        private readonly llmResolver: LlmClientResolver,
        private readonly modelSettings: LlmModelSettingsService,
        private readonly promptService: PropertyReportPromptService
    ) {}

    /**
     * Produce the property-report SMS text. Tries the LLM first; on ANY failure
     * (error, timeout, empty output, missing key) returns the deterministic
     * fallback so Jake always replies. Both paths are guaranteed emoji-free and
     * end with the exact GoTextJake.com footer.
     */
    async write(
        data: PropertyReportData,
        fullRecord?: RealEstateApiPropertySearchResult
    ): Promise<string> {
        // JAK-143: resolve the property-report surface's own provider+model (falls
        // back to the global Doppler default when unset) into a concrete client.
        const selection = await this.modelSettings.getEffectiveSelection("property_report");
        const llm = this.llmResolver.resolve(selection);
        // No key for the selected provider → straight to the deterministic
        // fallback (no network, no spend).
        if (llm.isAvailable) {
            try {
                const style = await this.promptService.getEffectivePrompt();
                const raw = await this.generateWithLlm(llm, data, style, fullRecord);
                const clean = this.stripEmojis(raw).trim();
                if (clean) return this.enforceFooter(clean);
                console.warn("⚠️ PropertyReportWriter: empty LLM output — using deterministic fallback.");
            } catch (err) {
                console.error(
                    "⚠️ PropertyReportWriter: LLM call failed — using deterministic fallback:",
                    err instanceof Error ? err.message : "unknown error"
                );
            }
        }
        return this.renderFallback(data);
    }

    /** Generate via the resolved LLM client with the verified data. Throws on error/timeout (caught by {@link write}). */
    protected async generateWithLlm(
        llm: LlmClient,
        data: PropertyReportData,
        style: string,
        fullRecord?: RealEstateApiPropertySearchResult
    ): Promise<string> {
        const [system, user] = this.buildMessages(data, style, fullRecord);
        return llm.generateText({
            system: system.content,
            user: user.content,
            maxTokens: PropertyReportWriter.MAX_TOKENS,
            temperature: 0.2,
        });
    }

    /**
     * Compose the full system prompt: persona + the admin-editable STYLE prompt +
     * the always-on HARD GUARDRAILS. The guardrails come LAST so they are the
     * model's final, controlling instruction and can never be edited away.
     */
    composeSystemPrompt(style: string): string {
        return [
            PropertyReportWriter.PERSONA,
            "",
            "=== STYLE (admin-configurable) ===",
            style.trim(),
            "",
            PropertyReportWriter.HARD_GUARDRAILS,
        ].join("\n");
    }

    /**
     * The system + user messages. `style` is the (admin-editable) STYLE prompt;
     * the guardrails are added by {@link composeSystemPrompt}. Public + sync so
     * tests can assert prompt contents directly.
     *
     * JAK-132: when the caller supplies the FULL PropertySearch record we hand the
     * model the WHOLE verified response as JSON — not just the curated subset — so
     * it can dynamically surface money + distress fields (mortgage balance,
     * foreclosure/pre-foreclosure, tax lien/judgment) without us extending a type
     * per field. The curated, derived block (friendly labels like "Out-of-State
     * Absentee Owner", "Free & Clear", lot acres) rides along beside it so those
     * derivations aren't lost. Everything here is ground truth — the guardrails
     * still forbid inventing or altering any of it.
     */
    buildMessages(
        data: PropertyReportData,
        style: string,
        fullRecord?: RealEstateApiPropertySearchResult
    ): { role: "system" | "user"; content: string }[] {
        return [
            { role: "system", content: this.composeSystemPrompt(style) },
            { role: "user", content: this.buildUserPayload(data, fullRecord) },
        ];
    }

    /**
     * The user message. With a full record present we send the COMPLETE verified
     * response plus our derived highlights; without one (legacy/offline callers)
     * we send just the curated data. Prefixed with an explicit "use only these
     * values" instruction reinforcing the only-provided-values guardrail.
     */
    private buildUserPayload(
        data: PropertyReportData,
        fullRecord?: RealEstateApiPropertySearchResult
    ): string {
        if (!fullRecord) {
            return (
                "Verified property data (use only these values):\n" +
                JSON.stringify(data, null, 2)
            );
        }
        return [
            "Verified property data (use ONLY these values — do not invent anything not present here).",
            "",
            "Full property record (the complete verified response — pick whichever fields are useful):",
            JSON.stringify(fullRecord, null, 2),
            "",
            "Derived highlights (friendly labels we computed from the record above):",
            JSON.stringify(data, null, 2),
        ].join("\n");
    }

    /**
     * Deterministic, emoji-free plain-text report from the SAME verified data.
     * Used whenever the LLM path is unavailable — and it is the offline path.
     */
    renderFallback(data: PropertyReportData): string {
        const chunks: (string | null)[] = [
            "Jake Property Report",
            [data.addressLine1, data.addressLine2].filter(Boolean).join("\n") || null,
            this.section("Property", [
                data.propertyType ?? null,
                this.bedsBaths(data),
                data.squareFeet != null ? `${this.num(data.squareFeet)} Sq Ft` : null,
                data.lotAcres != null ? `Lot Size: ${data.lotAcres.toFixed(2)} Acres` : null,
                data.yearBuilt != null ? `Built ${data.yearBuilt}` : null,
            ]),
            data.estimatedMarketValue != null
                ? `Estimated Market Value\n${this.money(data.estimatedMarketValue)}`
                : null,
            this.section("Ownership", [
                data.owner1 ?? null,
                data.owner2 ?? null,
                data.equityPercent != null
                    ? `${data.equityPercent}% Equity${data.freeAndClear ? " (Free & Clear)" : ""}`
                    : null,
                data.equityLevel ?? null,
                data.occupancy ?? null,
                data.absenteeStatus ?? null,
                data.yearsOwned != null ? `Years Owned: ${data.yearsOwned}` : null,
            ]),
            this.section("Financials", [
                data.estimatedMortgageBalance != null
                    ? `Estimated Mortgage Balance: ${this.money(data.estimatedMortgageBalance)}`
                    : null,
                data.estimatedMortgagePayment != null
                    ? `Estimated Mortgage Payment: ${this.money(data.estimatedMortgagePayment)}`
                    : null,
                data.estimatedEquity != null
                    ? `Estimated Equity: ${this.money(data.estimatedEquity)}`
                    : null,
            ]),
            this.distressSection(data),
            this.section("History", [
                data.lastSoldDate ? `Last Sold: ${data.lastSoldDate}` : null,
                data.salePrice != null ? `Sale Price: ${this.money(data.salePrice)}` : null,
            ]),
            this.section("Additional Information", [
                data.femaFloodZone ? `FEMA Flood Zone ${data.femaFloodZone}` : null,
                data.mlsListed == null ? null : data.mlsListed ? "Listed on MLS" : "Not Currently Listed on MLS",
            ]),
            PropertyReportWriter.FOOTER,
        ];

        return chunks.filter((c): c is string => Boolean(c)).join("\n\n");
    }

    private section(title: string, bullets: (string | null)[]): string | null {
        const clean = bullets.filter((b): b is string => typeof b === "string" && b.trim().length > 0);
        if (!clean.length) return null;
        return [title, ...clean.map((b) => `• ${b}`)].join("\n");
    }

    /**
     * The "Distress / Liens" section (JAK-132). These are Yes/No FLAGS — never
     * dollar amounts (the provider ships none). We list only the flags that are
     * TRUE. If the record carried the flags but none are set, we print a single
     * reassuring "No liens or foreclosure on record" line instead of a wall of
     * "No"s. If the flags were entirely absent (unknown), the section is omitted.
     */
    private distressSection(data: PropertyReportData): string | null {
        const flags: Array<[boolean | undefined, string]> = [
            [data.foreclosure, "Foreclosure"],
            [data.preForeclosure, "Pre-Foreclosure"],
            [data.reo, "Bank-Owned (REO)"],
            [
                data.auction,
                data.auctionDate ? `Auction (${data.auctionDate})` : "Auction",
            ],
            [data.taxLien, "Tax Lien"],
            [data.judgment, "Judgment"],
        ];
        const active = flags.filter(([v]) => v === true).map(([, label]) => label);
        if (active.length) return this.section("Distress / Liens", active);
        const anyKnown = flags.some(([v]) => typeof v === "boolean");
        if (anyKnown) return this.section("Distress / Liens", ["No liens or foreclosure on record"]);
        return null;
    }

    private bedsBaths(data: PropertyReportData): string | null {
        const parts: string[] = [];
        if (data.bedrooms != null) parts.push(`${data.bedrooms} Beds`);
        if (data.bathrooms != null) parts.push(`${data.bathrooms} Baths`);
        return parts.length ? parts.join(" | ") : null;
    }

    private num(n: number): string {
        return n.toLocaleString("en-US");
    }

    private money(n: number): string {
        return `$${Math.round(n).toLocaleString("en-US")}`;
    }

    /**
     * Force the message to end with EXACTLY the canonical footer — a hard-rule
     * safety net over the LLM output (JAK-131). If the model already ended with
     * it, this is a no-op; otherwise we strip any mangled/trailing footer-ish
     * block and append the exact two lines. Guarantees GoTextJake.com no matter
     * what the admin's stored STYLE prompt says.
     */
    private enforceFooter(text: string): string {
        const trimmed = text.trimEnd();
        if (trimmed.endsWith(PropertyReportWriter.FOOTER)) return trimmed;
        const withoutTail = trimmed
            // Drop a trailing footer-ish block if the model emitted a
            // partial/altered one, so we never double it up. Matches the current
            // tagline ("Every Lead Deserves Jake."), the prior JAK-157 tagline
            // ("Every lead deserves a Jake Report."), and the legacy
            // "Get more property info" one during rollout.
            .replace(/\n*(every lead deserves|get more property info)[\s\S]*$/i, "")
            .trimEnd();
        return `${withoutTail}\n\n${PropertyReportWriter.FOOTER}`;
    }

    /**
     * Strip emoji and pictographic symbols from text — a hard-rule safety net over
     * the LLM output so Jake can never send one even if the model slips.
     */
    private stripEmojis(text: string): string {
        return text
            .replace(
                /[\u{1F000}-\u{1FAFF}\u{1F1E6}-\u{1F1FF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}]/gu,
                ""
            )
            // collapse any spaces an emoji removal may have left doubled on a line
            .replace(/[ \t]{2,}/g, " ")
            .replace(/ +\n/g, "\n");
    }
}
