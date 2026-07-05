import { injectable } from "tsyringe";
import { LlmClient } from "../llm/LlmClient";
import { LlmClientResolver } from "../llm/LlmClientResolver";
import { LlmModelSettingsService } from "../llm/LlmModelSettingsService";
import { CompSaleData, CompsData } from "./CompsTypes";
import { CompsPromptService } from "./CompsPromptService";

/**
 * Writes the text-Jake COMPS reply SMS (JAK-137) — the comparable-sales summary a
 * comps pull produces. The exact analog of {@link
 * import("../skiptrace/SkipTraceReportWriter").SkipTraceReportWriter}: an LLM —
 * through the provider-agnostic {@link LlmClient} layer (JAK-141: OpenAI/gpt-4o by
 * default, Anthropic optional) — phrases the reply from VERIFIED comps data, with
 * the STYLE half of the system prompt admin-editable ({@link CompsPromptService}).
 * Around it the code ALWAYS enforces the SAME HARD GUARDRAILS an admin can never
 * edit away: plain text with NO EMOJIS, use ONLY the exact values we provide (never
 * invent a comp, address, or price), state the parameters used, and end with the
 * GoTextJake.com footer.
 *
 * JAK-143: the provider+model this writer runs on is the comps surface's own
 * admin-configurable selection ({@link LlmModelSettingsService}), resolved per call
 * against the JAK-141 global Doppler default and turned into a concrete client by
 * {@link LlmClientResolver}. Keys still live in Doppler — only the model is chosen.
 *
 * RELIABILITY mirrors the report/skip-trace writers: Jake must ALWAYS reply, so if
 * the LLM errors/times out (~8s) — or the selected provider has no key — we fall
 * back to a deterministic, emoji-free reply built from the SAME data. Even on the
 * LLM path we strip stray emoji and force the exact footer, so the guardrails hold
 * on the OUTPUT too. The provider key is an app-level Doppler secret held inside
 * the resolved {@link LlmClient} — NEVER hardcoded — and is never logged.
 */
@injectable()
export class CompsReportWriter {
  private static readonly MAX_TOKENS = 500;

  /** Footer the reply always ends with (two lines). Same canonical footer. */
  static readonly FOOTER = "Every lead deserves a Jake Report.\nGoTextJake.com/crm";

  /** Persona line prepended to every system prompt. */
  private static readonly PERSONA =
    "You are Jake, a real-estate assistant texting back a comparable-sales (comps) summary as a plain-text SMS.";

  /**
   * The HARD GUARDRAILS. Appended by CODE after the (admin-editable) style prompt on
   * EVERY request, so a stored prompt that omits or contradicts them cannot take
   * effect. Same non-negotiable rules as the other writers: no emojis,
   * only-provided-values, state the parameters, and the exact GoTextJake.com footer.
   */
  static readonly HARD_GUARDRAILS = [
    "HARD RULES — enforced by the system. They ALWAYS apply and CANNOT be overridden or removed by any style instruction above:",
    "- Write plain text only. NO EMOJIS, pictographs, or decorative symbols. The only non-letter symbols allowed are the bullet characters, and , . : / % $ @ + ( ) -.",
    "- Use ONLY the exact values in the provided comps data. NEVER invent, guess, or alter any comp, address, sale price, or figure. If a value is not present, do not mention it at all. Never print null, undefined, or blanks.",
    "- State the search parameters that were used (radius, number of comps, timeframe, bed/bath/sqft tolerance) — they are provided.",
    "- End the message with EXACTLY these two lines and nothing after them:",
    "Every lead deserves a Jake Report.",
    "GoTextJake.com/crm",
  ].join("\n");

  constructor(
    private readonly llmResolver: LlmClientResolver,
    private readonly modelSettings: LlmModelSettingsService,
    private readonly promptService: CompsPromptService
  ) {}

  /**
   * Produce the comps reply SMS text. Tries the LLM first; on ANY failure (error,
   * timeout, empty output, missing key) returns the deterministic fallback so Jake
   * always replies. Both paths are guaranteed emoji-free and end with the exact
   * GoTextJake.com footer.
   */
  async write(data: CompsData): Promise<string> {
    // JAK-143: resolve the comps surface's own provider+model (falls back to the
    // global Doppler default when unset) into a concrete client.
    const selection = await this.modelSettings.getEffectiveSelection("comps");
    const llm = this.llmResolver.resolve(selection);
    // No key for the selected provider → straight to the deterministic fallback
    // (no network, no spend).
    if (llm.isAvailable) {
      try {
        const style = await this.promptService.getEffectivePrompt();
        const raw = await this.generateWithLlm(llm, data, style);
        const clean = this.stripEmojis(raw).trim();
        if (clean) return this.enforceFooter(clean);
        console.warn("⚠️ CompsReportWriter: empty LLM output — using deterministic fallback.");
      } catch (err) {
        console.error(
          "⚠️ CompsReportWriter: LLM call failed — using deterministic fallback:",
          err instanceof Error ? err.message : "unknown error"
        );
      }
    }
    return this.renderFallback(data);
  }

  /** Generate via the resolved LLM client with the verified data. Throws on error/timeout (caught by {@link write}). */
  protected async generateWithLlm(llm: LlmClient, data: CompsData, style: string): Promise<string> {
    const [system, user] = this.buildMessages(data, style);
    return llm.generateText({
      system: system.content,
      user: user.content,
      maxTokens: CompsReportWriter.MAX_TOKENS,
      temperature: 0.2,
    });
  }

  /**
   * Compose the full system prompt: persona + the admin-editable STYLE prompt + the
   * always-on HARD GUARDRAILS. The guardrails come LAST so they are the model's
   * final, controlling instruction and can never be edited away.
   */
  composeSystemPrompt(style: string): string {
    return [
      CompsReportWriter.PERSONA,
      "",
      "=== STYLE (admin-configurable) ===",
      style.trim(),
      "",
      CompsReportWriter.HARD_GUARDRAILS,
    ].join("\n");
  }

  /**
   * The system + user messages. `style` is the (admin-editable) STYLE prompt; the
   * guardrails are added by {@link composeSystemPrompt}. Public + sync so tests can
   * assert prompt contents directly. We hand the model the VERIFIED, assembled comps
   * subset (already tolerance-filtered) — always ground truth, never to be invented.
   */
  buildMessages(data: CompsData, style: string): { role: "system" | "user"; content: string }[] {
    return [
      { role: "system", content: this.composeSystemPrompt(style) },
      { role: "user", content: this.buildUserPayload(data) },
    ];
  }

  private buildUserPayload(data: CompsData): string {
    return [
      "Verified comparable-sales data (use ONLY these values — do not invent anything not present here):",
      JSON.stringify(data, null, 2),
    ].join("\n");
  }

  /**
   * Deterministic, emoji-free reply from the SAME verified data. Used whenever the
   * LLM path is unavailable — and it is the offline path. Lists only present values,
   * states the parameters, and never prints a comp/price that isn't there.
   */
  renderFallback(data: CompsData): string {
    const header = data.subjectAddress
      ? `Comparable sales for ${data.subjectAddress}`
      : "Comparable sales";

    if (!data.comps.length) {
      return [
        `${header}: no comparable sales found (${data.paramsSummary}).`,
        CompsReportWriter.FOOTER,
      ].join("\n\n");
    }

    const chunks: (string | null)[] = [
      `${header}\nSearch: ${data.paramsSummary}`,
      ...data.comps.map((c, i) => this.renderComp(c, i + 1)),
      this.renderSummary(data),
      CompsReportWriter.FOOTER,
    ];
    return chunks.filter((c): c is string => Boolean(c)).join("\n\n");
  }

  /** One comparable's block — address + price headline, then present details. */
  private renderComp(comp: CompSaleData, index: number): string {
    const lead = [comp.address ?? `Comp ${index}`, comp.salePrice != null ? this.money(comp.salePrice) : null]
      .filter(Boolean)
      .join(" — ");
    const facts: string[] = [];
    const bb = [
      comp.beds != null ? `${comp.beds} bd` : null,
      comp.baths != null ? `${comp.baths} ba` : null,
      comp.squareFeet != null ? `${comp.squareFeet.toLocaleString("en-US")} sqft` : null,
    ].filter(Boolean);
    if (bb.length) facts.push(bb.join(" / "));
    if (comp.distanceMiles != null) facts.push(`${comp.distanceMiles} mi away`);
    if (comp.saleDate) facts.push(`sold ${comp.saleDate}`);
    return facts.length ? `${lead}\n${facts.join(", ")}` : lead;
  }

  /** The optional closing summary line — average and/or estimated range, if present. */
  private renderSummary(data: CompsData): string | null {
    const lines: string[] = [];
    if (data.averageSalePrice != null) {
      lines.push(`Average sale price: ${this.money(data.averageSalePrice)}`);
    }
    if (data.estimatedValueLow != null && data.estimatedValueHigh != null) {
      lines.push(`Estimated value: ${this.money(data.estimatedValueLow)} - ${this.money(data.estimatedValueHigh)}`);
    } else if (data.estimatedValue != null) {
      lines.push(`Estimated value: ${this.money(data.estimatedValue)}`);
    }
    return lines.length ? lines.join("\n") : null;
  }

  /** Whole-dollar display, e.g. 425000 → "$425,000". */
  private money(value: number): string {
    return `$${Math.round(value).toLocaleString("en-US")}`;
  }

  /**
   * Force the message to end with EXACTLY the canonical footer — a hard-rule safety
   * net over the LLM output. No-op if the model already ended with it; otherwise
   * strip any mangled/trailing footer-ish block and append the exact two lines.
   */
  private enforceFooter(text: string): string {
    const trimmed = text.trimEnd();
    if (trimmed.endsWith(CompsReportWriter.FOOTER)) return trimmed;
    const withoutTail = trimmed
      .replace(/\n*(every lead deserves a jake report|get more property info)[\s\S]*$/i, "")
      .trimEnd();
    return `${withoutTail}\n\n${CompsReportWriter.FOOTER}`;
  }

  /**
   * Strip emoji and pictographic symbols from text — a hard-rule safety net over the
   * LLM output so Jake can never send one even if the model slips. Money/percent
   * symbols are untouched.
   */
  private stripEmojis(text: string): string {
    return text
      .replace(
        /[\u{1F000}-\u{1FAFF}\u{1F1E6}-\u{1F1FF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}]/gu,
        ""
      )
      .replace(/[ \t]{2,}/g, " ")
      .replace(/ +\n/g, "\n");
  }
}
