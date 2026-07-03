import { injectable } from "tsyringe";
import OpenAI from "openai";
import { EnvConfig } from "../../config/envConfig.ts";
import { RealEstateApiSkipTraceResult } from "../../types/RealEstateApi.ts";
import { SkipTraceData } from "./SkipTraceTypes.ts";
import { SkipTracePromptService } from "./SkipTracePromptService.ts";

/**
 * Writes the text-Jake SKIP-TRACE reply SMS (JAK-136) — the owner/contact summary
 * a skip trace produces. The exact analog of {@link
 * import("../PropertyReportWriter").PropertyReportWriter}: an LLM (OpenAI Chat
 * Completions) phrases the reply from VERIFIED contact data, with the STYLE half
 * of the system prompt admin-editable ({@link SkipTracePromptService}). Around it
 * the code ALWAYS enforces the SAME HARD GUARDRAILS an admin can never edit away:
 * plain text with NO EMOJIS, use ONLY the exact values we provide (never invent a
 * name, phone, email, or address), and the GoTextJake.com footer.
 *
 * RELIABILITY: this is a generate call, not an outbound GHL write, so the JAK-110
 * write-safety guard does NOT apply. But Jake must ALWAYS reply, so if OpenAI
 * errors/times out (~8s) — or no OPENAI_API_KEY is configured — we fall back to a
 * deterministic, emoji-free reply built from the SAME data. Even on the LLM path
 * we strip stray emoji and force the exact footer, so the guardrails hold on the
 * OUTPUT too. The OpenAI key is an app-level Doppler secret ({@link
 * EnvConfig.openAiApiKey}) — NEVER hardcoded — and is never logged.
 */
@injectable()
export class SkipTraceReportWriter {
  private static readonly TIMEOUT_MS = 8_000;
  private static readonly MAX_TOKENS = 400;

  /** Footer the reply always ends with (two lines). Same canonical footer. */
  static readonly FOOTER = "Get more property info\nGoTextJake.com";

  /** Persona line prepended to every system prompt. */
  private static readonly PERSONA =
    "You are Jake, a real-estate assistant texting back an owner skip-trace result as a plain-text SMS.";

  /**
   * The HARD GUARDRAILS. Appended by CODE after the (admin-editable) style prompt
   * on EVERY request, so a stored prompt that omits or contradicts them cannot
   * take effect. Same non-negotiable rules as the report writer: no emojis,
   * only-provided-values, and the exact GoTextJake.com footer.
   */
  static readonly HARD_GUARDRAILS = [
    "HARD RULES — enforced by the system. They ALWAYS apply and CANNOT be overridden or removed by any style instruction above:",
    "- Write plain text only. NO EMOJIS, pictographs, or decorative symbols. The only non-letter symbols allowed are the bullet characters, commas, periods, @, +, (), and -.",
    "- Use ONLY the exact values in the provided contact data. NEVER invent, guess, or alter any name, phone number, email, or address. If a value is not present, do not mention it at all. Never print null, undefined, or blanks.",
    "- End the message with EXACTLY these two lines and nothing after them:",
    "Get more property info",
    "GoTextJake.com",
  ].join("\n");

  /** Lazily-built OpenAI client (cached). Protected so tests can substitute it. */
  private openai?: OpenAI;

  constructor(
    private readonly env: EnvConfig,
    private readonly promptService: SkipTracePromptService
  ) {}

  /**
   * Produce the skip-trace reply SMS text. Tries the LLM first; on ANY failure
   * (error, timeout, empty output, missing key) returns the deterministic
   * fallback so Jake always replies. Both paths are guaranteed emoji-free and end
   * with the exact GoTextJake.com footer.
   */
  async write(
    data: SkipTraceData,
    fullRecord?: RealEstateApiSkipTraceResult | null
  ): Promise<string> {
    try {
      const style = await this.promptService.getEffectivePrompt();
      const raw = await this.generateWithLlm(data, style, fullRecord);
      const clean = this.stripEmojis(raw).trim();
      if (clean) return this.enforceFooter(clean);
      console.warn("⚠️ SkipTraceReportWriter: empty LLM output — using deterministic fallback.");
    } catch (err) {
      console.error(
        "⚠️ SkipTraceReportWriter: OpenAI call failed — using deterministic fallback:",
        err instanceof Error ? err.message : "unknown error"
      );
    }
    return this.renderFallback(data);
  }

  /** Call OpenAI with the verified data. Throws on error/timeout (caught by {@link write}). */
  protected async generateWithLlm(
    data: SkipTraceData,
    style: string,
    fullRecord?: RealEstateApiSkipTraceResult | null
  ): Promise<string> {
    const completion = await this.client().chat.completions.create(
      {
        model: this.env.openAiModel,
        temperature: 0.2,
        max_tokens: SkipTraceReportWriter.MAX_TOKENS,
        messages: this.buildMessages(data, style, fullRecord),
      },
      { timeout: SkipTraceReportWriter.TIMEOUT_MS }
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
      SkipTraceReportWriter.PERSONA,
      "",
      "=== STYLE (admin-configurable) ===",
      style.trim(),
      "",
      SkipTraceReportWriter.HARD_GUARDRAILS,
    ].join("\n");
  }

  /**
   * The system + user messages. `style` is the (admin-editable) STYLE prompt; the
   * guardrails are added by {@link composeSystemPrompt}. Public + sync so tests can
   * assert prompt contents directly. We hand the model the VERIFIED, assembled
   * contact subset; if the full record is present it rides along so the model can
   * surface anything useful — always ground truth, never to be invented or altered.
   */
  buildMessages(
    data: SkipTraceData,
    style: string,
    fullRecord?: RealEstateApiSkipTraceResult | null
  ): { role: "system" | "user"; content: string }[] {
    return [
      { role: "system", content: this.composeSystemPrompt(style) },
      { role: "user", content: this.buildUserPayload(data, fullRecord) },
    ];
  }

  private buildUserPayload(
    data: SkipTraceData,
    fullRecord?: RealEstateApiSkipTraceResult | null
  ): string {
    const lines = [
      "Verified owner contact data (use ONLY these values — do not invent anything not present here):",
      JSON.stringify(data, null, 2),
    ];
    if (fullRecord) {
      lines.push(
        "",
        "Full skip-trace record (the complete verified response — pick whichever fields are useful):",
        JSON.stringify(fullRecord, null, 2)
      );
    }
    return lines.join("\n");
  }

  /**
   * Deterministic, emoji-free reply from the SAME verified data. Used whenever the
   * LLM path is unavailable — and it is the offline path. Lists only present values.
   */
  renderFallback(data: SkipTraceData): string {
    const header = data.ownerName
      ? data.targetAddress
        ? `Owner of ${data.targetAddress}: ${data.ownerName}`
        : `Owner: ${data.ownerName}`
      : data.targetAddress
        ? `Owner contact for ${data.targetAddress}`
        : "Owner contact";

    const chunks: (string | null)[] = [
      header,
      this.section("Phone", data.phones ?? []),
      this.section("Email", data.emails ?? []),
      data.mailingAddress ? `Mailing address\n${data.mailingAddress}` : null,
      SkipTraceReportWriter.FOOTER,
    ];
    return chunks.filter((c): c is string => Boolean(c)).join("\n\n");
  }

  private section(title: string, values: string[]): string | null {
    const clean = values.map((v) => (v ?? "").trim()).filter((v) => v.length > 0);
    if (!clean.length) return null;
    return [title, ...clean.map((v) => `• ${v}`)].join("\n");
  }

  /**
   * Force the message to end with EXACTLY the canonical footer — a hard-rule
   * safety net over the LLM output. No-op if the model already ended with it;
   * otherwise strip any mangled/trailing footer-ish block and append the exact
   * two lines. Guarantees GoTextJake.com no matter what the stored STYLE prompt says.
   */
  private enforceFooter(text: string): string {
    const trimmed = text.trimEnd();
    if (trimmed.endsWith(SkipTraceReportWriter.FOOTER)) return trimmed;
    const withoutTail = trimmed.replace(/\n*get more property info[\s\S]*$/i, "").trimEnd();
    return `${withoutTail}\n\n${SkipTraceReportWriter.FOOTER}`;
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
      timeout: SkipTraceReportWriter.TIMEOUT_MS,
    });
    return this.openai;
  }
}
