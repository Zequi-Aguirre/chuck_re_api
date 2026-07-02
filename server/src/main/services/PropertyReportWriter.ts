import { injectable } from "tsyringe";
import OpenAI from "openai";
import { EnvConfig } from "../config/envConfig.ts";
import { PropertyReportData } from "../types/PropertyReport.ts";
import { PropertyReportPromptService } from "./PropertyReportPromptService.ts";

/**
 * Writes the text-Jake "Jake Property Report" SMS (JAK-130).
 *
 * The report is written by an LLM (OpenAI Chat Completions) that DYNAMICALLY
 * decides which of the verified fields are worth including — there's no rigid
 * template. The STYLE/FORMAT half of the system prompt is admin-editable and
 * stored in the DB ({@link PropertyReportPromptService}, JAK-131). Around it the
 * code ALWAYS enforces the HARD GUARDRAILS, which an admin can never edit away:
 * plain text with NO EMOJIS, use ONLY the exact values we provide (never invent,
 * guess, or alter any number/name/price/fact), and the GoTextJake.com footer.
 * The property data goes in the user message as JSON.
 *
 * RELIABILITY: this is a generate/read call, not an outbound GHL write, so the
 * JAK-110 write-safety guard does NOT apply. But Jake must ALWAYS reply, so if
 * OpenAI errors or times out (~8s) we fall back to a deterministic, emoji-free
 * plain-text report built from the SAME data. That fallback doubles as the
 * offline path when no OPENAI_API_KEY is configured. Even on the LLM path we
 * strip any stray emoji from the model output and force the exact footer as a
 * belt-and-suspenders guard, so those guardrails hold on the OUTPUT too — not
 * just in the prompt — regardless of what the admin typed.
 *
 * The OpenAI API key is an app-level Doppler secret ({@link EnvConfig.openAiApiKey})
 * — NEVER hardcoded — and is never logged.
 */
@injectable()
export class PropertyReportWriter {
    private static readonly TIMEOUT_MS = 8_000;
    private static readonly MAX_TOKENS = 500;

    /** Footer the report always ends with (two lines). */
    static readonly FOOTER = "Get more property info\nGoTextJake.com";

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
        "Get more property info",
        "GoTextJake.com",
    ].join("\n");

    /** Lazily-built OpenAI client (cached). Protected so tests can substitute it. */
    private openai?: OpenAI;

    constructor(
        private readonly env: EnvConfig,
        private readonly promptService: PropertyReportPromptService
    ) {}

    /**
     * Produce the property-report SMS text. Tries the LLM first; on ANY failure
     * (error, timeout, empty output, missing key) returns the deterministic
     * fallback so Jake always replies. Both paths are guaranteed emoji-free and
     * end with the exact GoTextJake.com footer.
     */
    async write(data: PropertyReportData): Promise<string> {
        try {
            const style = await this.promptService.getEffectivePrompt();
            const raw = await this.generateWithLlm(data, style);
            const clean = this.stripEmojis(raw).trim();
            if (clean) return this.enforceFooter(clean);
            console.warn("⚠️ PropertyReportWriter: empty LLM output — using deterministic fallback.");
        } catch (err) {
            console.error(
                "⚠️ PropertyReportWriter: OpenAI call failed — using deterministic fallback:",
                err instanceof Error ? err.message : "unknown error"
            );
        }
        return this.renderFallback(data);
    }

    /** Call OpenAI with the verified data. Throws on error/timeout (caught by {@link write}). */
    protected async generateWithLlm(data: PropertyReportData, style: string): Promise<string> {
        const completion = await this.client().chat.completions.create(
            {
                model: this.env.openAiModel,
                temperature: 0.2,
                max_tokens: PropertyReportWriter.MAX_TOKENS,
                messages: this.buildMessages(data, style),
            },
            { timeout: PropertyReportWriter.TIMEOUT_MS }
        );
        return completion.choices?.[0]?.message?.content ?? "";
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
     */
    buildMessages(
        data: PropertyReportData,
        style: string
    ): { role: "system" | "user"; content: string }[] {
        return [
            { role: "system", content: this.composeSystemPrompt(style) },
            {
                role: "user",
                content:
                    "Verified property data (use only these values):\n" +
                    JSON.stringify(data, null, 2),
            },
        ];
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
            // Drop a trailing "Get more property info ... " block if the model
            // emitted a partial/altered one, so we never double it up.
            .replace(/\n*get more property info[\s\S]*$/i, "")
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

    /** Build (and cache) the OpenAI client. Protected so tests can substitute it. */
    protected client(): OpenAI {
        if (this.openai) return this.openai;
        if (!this.env.openAiApiKey) {
            throw new Error("OPENAI_API_KEY is not configured");
        }
        this.openai = new OpenAI({
            apiKey: this.env.openAiApiKey,
            timeout: PropertyReportWriter.TIMEOUT_MS,
        });
        return this.openai;
    }
}
