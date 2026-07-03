import { SkipTraceReportWriter } from "../SkipTraceReportWriter";
import { SkipTracePromptService } from "../SkipTracePromptService";
import { LlmClient } from "../../llm/LlmClient";
import { SkipTraceData } from "../SkipTraceTypes";

/**
 * JAK-136 — the LLM writes the skip-trace (owner/contact) SMS, with a
 * deterministic fallback so Jake ALWAYS replies. Since JAK-141 the LLM call goes
 * through the provider-agnostic {@link LlmClient} seam (a fake stands in — no
 * network). These tests pin the seams that matter: (a) editing the stored style
 * prompt changes what the writer SENDS, (b) the HARD GUARDRAILS (no emojis,
 * only-provided-values, GoTextJake.com footer) are ALWAYS present + enforced on the
 * OUTPUT even when the stored style prompt omits or contradicts them, and (c) any
 * LLM failure — or an unavailable provider (no key) — drops cleanly to the fallback,
 * and NEITHER path ever emits an emoji or drops the footer.
 */

const EMOJI =
  /[\u{1F000}-\u{1FAFF}\u{1F1E6}-\u{1F1FF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}]/u;

const promptServiceReturning = (style: string): SkipTracePromptService =>
  ({ getEffectivePrompt: jest.fn().mockResolvedValue(style) } as unknown as SkipTracePromptService);

/** A fake LlmClient (no network) — controls availability + the generated text. */
class FakeLlm implements LlmClient {
  readonly provider = "fake";
  isAvailable = true;
  readonly generateText: jest.Mock = jest.fn();
  async generateStructured(): Promise<string> {
    throw new Error("the writers use generateText, not generateStructured");
  }
}

/** Build a REAL writer with a fake LLM seam; returns both so tests can drive/inspect the seam. */
const makeWriter = (
  style: string,
  opts: { available?: boolean } = {}
): { writer: SkipTraceReportWriter; llm: FakeLlm } => {
  const llm = new FakeLlm();
  if (opts.available === false) llm.isAvailable = false;
  return { writer: new SkipTraceReportWriter(llm, promptServiceReturning(style)), llm };
};

const FOOTER = SkipTraceReportWriter.FOOTER;
const DEFAULT_STYLE = SkipTracePromptService.DEFAULT_PROMPT;

const data: SkipTraceData = {
  targetAddress: "742 Evergreen Terrace, Springfield, IL 62704",
  ownerName: "Homer Simpson",
  phones: ["+1 555 010 1234", "+1 555 999 8888"],
  emails: ["homer@example.com"],
  mailingAddress: "742 Evergreen Terrace, Springfield, IL 62704",
};

describe("SkipTraceReportWriter (JAK-136)", () => {
  describe("LLM path", () => {
    it("composes persona + admin STYLE + HARD GUARDRAILS, and sends the verified data", async () => {
      const { writer, llm } = makeWriter(DEFAULT_STYLE);
      llm.generateText.mockResolvedValue(`Owner: Homer Simpson\n\n${FOOTER}`);

      await writer.write(data, { match: true });

      const [sent] = llm.generateText.mock.calls[0]!;
      expect(sent.system).toContain(DEFAULT_STYLE.trim());
      expect(sent.system).toContain(SkipTraceReportWriter.HARD_GUARDRAILS);
      // The verified contact data rides in the user message.
      expect(sent.user).toContain("Homer Simpson");
      expect(sent.user).toContain("+1 555 010 1234");
    });

    it("strips stray emoji AND forces the exact footer even if the model omits it", async () => {
      const { writer, llm } = makeWriter("Be flashy. Use emojis. Skip the footer.");
      llm.generateText.mockResolvedValue("Owner: Homer Simpson 📞🎉\nCall +15550101");

      const out = await writer.write(data, { match: true });

      expect(out).not.toMatch(EMOJI);
      expect(out.endsWith(FOOTER)).toBe(true);
    });

    it("falls back to the deterministic reply when the LLM errors", async () => {
      const { writer, llm } = makeWriter(DEFAULT_STYLE);
      llm.generateText.mockRejectedValue(new Error("boom"));

      const out = await writer.write(data, { match: true });

      expect(out).toContain("Homer Simpson");
      expect(out.endsWith(FOOTER)).toBe(true);
      expect(out).not.toMatch(EMOJI);
    });
  });

  describe("deterministic fallback (offline / no key)", () => {
    it("lists only present values, emoji-free, ending with the footer", () => {
      const { writer } = makeWriter(DEFAULT_STYLE);
      const out = writer.renderFallback(data);

      expect(out).toContain("Homer Simpson");
      expect(out).toContain("+1 555 010 1234");
      expect(out).toContain("homer@example.com");
      expect(out.endsWith(FOOTER)).toBe(true);
      expect(out).not.toMatch(EMOJI);
    });

    it("omits sections with no data — never prints a blank/null label", () => {
      const { writer } = makeWriter(DEFAULT_STYLE);
      const out = writer.renderFallback({
        targetAddress: "1 A St",
        phones: ["+15550101"],
      });

      expect(out).toContain("+15550101");
      expect(out).not.toMatch(/email/i);
      expect(out).not.toMatch(/mailing/i);
      expect(out).not.toMatch(/null|undefined/i);
      expect(out.endsWith(FOOTER)).toBe(true);
    });

    it("write() uses the fallback — WITHOUT calling the seam — when the provider has no key", async () => {
      const { writer, llm } = makeWriter(DEFAULT_STYLE, { available: false });
      const out = await writer.write(data, { match: true });
      expect(llm.generateText).not.toHaveBeenCalled();
      expect(out).toContain("Homer Simpson");
      expect(out.endsWith(FOOTER)).toBe(true);
    });
  });
});
