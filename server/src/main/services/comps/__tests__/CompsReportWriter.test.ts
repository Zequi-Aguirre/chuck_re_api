import { CompsReportWriter } from "../CompsReportWriter";
import { CompsPromptService } from "../CompsPromptService";
import { EnvConfig } from "../../../config/envConfig";
import { CompsData, DEFAULT_COMP_PARAMS, formatCompParams } from "../CompsTypes";

/**
 * JAK-137 — the LLM writes the comps SMS, with a deterministic fallback so Jake
 * ALWAYS replies. The STYLE half of the prompt is admin-editable; these tests pin
 * the seams that matter: (a) editing the stored style prompt changes what the writer
 * SENDS, (b) the HARD GUARDRAILS (no emojis, only-provided-values, footer, state the
 * parameters) are ALWAYS present + enforced on the OUTPUT even when the stored style
 * prompt omits or contradicts them, and (c) any OpenAI failure drops cleanly to the
 * fallback — and NEITHER path ever emits an emoji or drops the footer.
 */

const EMOJI =
  /[\u{1F000}-\u{1FAFF}\u{1F1E6}-\u{1F1FF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}]/u;

const promptServiceReturning = (style: string): CompsPromptService =>
  ({ getEffectivePrompt: jest.fn().mockResolvedValue(style) } as unknown as CompsPromptService);

/** Subclass swapping the real OpenAI client for a controllable fake. */
class TestWriter extends CompsReportWriter {
  public readonly create: jest.Mock = jest.fn();
  protected client(): any {
    return { chat: { completions: { create: this.create } } };
  }
}

const envWith = (over: Partial<EnvConfig> = {}): EnvConfig =>
  ({ openAiApiKey: "test-key", openAiModel: "gpt-4o-mini", ...over } as unknown as EnvConfig);

const makeWriter = (style: string, over: Partial<EnvConfig> = {}): TestWriter =>
  new TestWriter(envWith(over), promptServiceReturning(style));

const FOOTER = CompsReportWriter.FOOTER;
const DEFAULT_STYLE = CompsPromptService.DEFAULT_PROMPT;

const data: CompsData = {
  subjectAddress: "742 Evergreen Terrace, Springfield, IL 62704",
  params: DEFAULT_COMP_PARAMS,
  paramsSummary: formatCompParams(DEFAULT_COMP_PARAMS),
  comps: [
    { address: "123 Nearby St", salePrice: 400000, beds: 3, baths: 2, squareFeet: 1500, distanceMiles: 0.4, saleDate: "03/01/2026" },
    { address: "456 Close Ave", salePrice: 420000, beds: 3, baths: 2, squareFeet: 1600 },
  ],
  averageSalePrice: 410000,
  estimatedValueLow: 395000,
  estimatedValueHigh: 430000,
};

describe("CompsReportWriter (JAK-137)", () => {
  describe("LLM path", () => {
    it("composes persona + admin STYLE + HARD GUARDRAILS, and sends the verified data", async () => {
      const writer = makeWriter(DEFAULT_STYLE);
      writer.create.mockResolvedValue({
        choices: [{ message: { content: `Comparable sales for 742 Evergreen Terrace\n\n${FOOTER}` } }],
      });

      await writer.write(data);

      const sentMessages = writer.create.mock.calls[0]![0].messages;
      const system = sentMessages[0].content as string;
      expect(system).toContain(DEFAULT_STYLE.trim());
      expect(system).toContain(CompsReportWriter.HARD_GUARDRAILS);
      // The verified comps data rides in the user message.
      expect(sentMessages[1].content).toContain("123 Nearby St");
      expect(sentMessages[1].content).toContain("400000");
    });

    it("strips stray emoji AND forces the exact footer even if the model omits it", async () => {
      const writer = makeWriter("Be flashy. Use emojis. Skip the footer.");
      writer.create.mockResolvedValue({
        choices: [{ message: { content: "Comps for 742 Evergreen 🏡🎉\n123 Nearby St $400,000" } }],
      });

      const out = await writer.write(data);

      expect(out).not.toMatch(EMOJI);
      expect(out.endsWith(FOOTER)).toBe(true);
    });

    it("falls back to the deterministic reply when OpenAI errors", async () => {
      const writer = makeWriter(DEFAULT_STYLE);
      writer.create.mockRejectedValue(new Error("boom"));

      const out = await writer.write(data);

      expect(out).toContain("123 Nearby St");
      expect(out.endsWith(FOOTER)).toBe(true);
      expect(out).not.toMatch(EMOJI);
    });
  });

  describe("deterministic fallback (offline / no key)", () => {
    it("lists comps + prices + the parameters used, emoji-free, ending with the footer", () => {
      const writer = makeWriter(DEFAULT_STYLE);
      const out = writer.renderFallback(data);

      expect(out).toContain("123 Nearby St");
      expect(out).toContain("$400,000");
      expect(out).toContain("$420,000");
      // States the parameters used.
      expect(out).toContain("up to 5 comps");
      // Summary line from present data.
      expect(out).toContain("$410,000");
      expect(out).toContain("$395,000 - $430,000");
      expect(out.endsWith(FOOTER)).toBe(true);
      expect(out).not.toMatch(EMOJI);
    });

    it("renders a clean no-comps message when none were found", () => {
      const writer = makeWriter(DEFAULT_STYLE);
      const out = writer.renderFallback({
        subjectAddress: "1 A St",
        params: DEFAULT_COMP_PARAMS,
        paramsSummary: formatCompParams(DEFAULT_COMP_PARAMS),
        comps: [],
      });

      expect(out.toLowerCase()).toContain("no comparable sales");
      expect(out).not.toMatch(/null|undefined/i);
      expect(out.endsWith(FOOTER)).toBe(true);
    });

    it("omits details a comp doesn't have — never prints a blank/null label", () => {
      const writer = makeWriter(DEFAULT_STYLE);
      const out = writer.renderFallback({
        subjectAddress: "1 A St",
        params: DEFAULT_COMP_PARAMS,
        paramsSummary: formatCompParams(DEFAULT_COMP_PARAMS),
        comps: [{ address: "9 Only Address Rd" }],
      });

      expect(out).toContain("9 Only Address Rd");
      expect(out).not.toMatch(/null|undefined/i);
      expect(out.endsWith(FOOTER)).toBe(true);
    });

    it("write() uses the fallback when no OPENAI_API_KEY is configured", async () => {
      const writer = makeWriter(DEFAULT_STYLE, { openAiApiKey: "" });
      const out = await writer.write(data);
      expect(out).toContain("123 Nearby St");
      expect(out.endsWith(FOOTER)).toBe(true);
    });
  });
});
