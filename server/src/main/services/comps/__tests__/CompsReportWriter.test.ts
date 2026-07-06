import { CompsReportWriter } from "../CompsReportWriter";
import { CompsPromptService } from "../CompsPromptService";
import { LlmClient } from "../../llm/LlmClient";
import { LlmClientResolver } from "../../llm/LlmClientResolver";
import { LlmModelSettingsService } from "../../llm/LlmModelSettingsService";
import { LlmSelection, LlmSelectionOverride } from "../../llm/LlmSelection";
import { CompsData, DEFAULT_COMP_PARAMS, formatCompParams } from "../CompsTypes";

/**
 * JAK-137 — the LLM writes the comps SMS, with a deterministic fallback so Jake
 * ALWAYS replies. Since JAK-141 the LLM call goes through the provider-agnostic
 * {@link LlmClient} seam (a fake stands in — no network). These tests pin the seams
 * that matter: (a) editing the stored style prompt changes what the writer SENDS,
 * (b) the HARD GUARDRAILS (no emojis, only-provided-values, footer, state the
 * parameters) are ALWAYS present + enforced on the OUTPUT even when the stored style
 * prompt omits or contradicts them, and (c) any LLM failure — or an unavailable
 * provider (no key) — drops cleanly to the fallback, and NEITHER path ever emits an
 * emoji or drops the footer.
 */

const EMOJI =
  /[\u{1F000}-\u{1FAFF}\u{1F1E6}-\u{1F1FF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}]/u;

const promptServiceReturning = (style: string): CompsPromptService =>
  ({ getEffectivePrompt: jest.fn().mockResolvedValue(style) } as unknown as CompsPromptService);

/** A fake LlmClient (no network) — controls availability + the generated text. */
class FakeLlm implements LlmClient {
  readonly provider = "fake";
  readonly model = "fake-model";
  isAvailable = true;
  readonly generateText: jest.Mock = jest.fn();
  async generateStructured(): Promise<string> {
    throw new Error("the writers use generateText, not generateStructured");
  }
}

/** A stub resolver that always returns `llm` and records the selection it was asked for. */
const resolverFor = (llm: LlmClient): LlmClientResolver & { lastOverride?: LlmSelectionOverride | null } => {
  const stub = {
    lastOverride: undefined as LlmSelectionOverride | null | undefined,
    resolve(override?: LlmSelectionOverride | null) {
      stub.lastOverride = override ?? null;
      return llm;
    },
    effectiveSelection: () => ({ provider: "openai", model: "gpt-4o" }) as LlmSelection,
  };
  return stub as unknown as LlmClientResolver & { lastOverride?: LlmSelectionOverride | null };
};

/** A stub settings service returning a fixed effective selection for the comps surface. */
const settingsReturning = (
  selection: LlmSelection = { provider: "openai", model: "gpt-4o" }
): LlmModelSettingsService =>
  ({ getEffectiveSelection: jest.fn().mockResolvedValue(selection) } as unknown as LlmModelSettingsService);

/** Build a REAL writer with a fake LLM seam; returns both so tests can drive/inspect the seam. */
const makeWriter = (
  style: string,
  opts: { available?: boolean; selection?: LlmSelection } = {}
): { writer: CompsReportWriter; llm: FakeLlm; resolver: ReturnType<typeof resolverFor>; settings: LlmModelSettingsService } => {
  const llm = new FakeLlm();
  if (opts.available === false) llm.isAvailable = false;
  const resolver = resolverFor(llm);
  const settings = settingsReturning(opts.selection);
  return { writer: new CompsReportWriter(resolver, settings, promptServiceReturning(style)), llm, resolver, settings };
};

const FOOTER = CompsReportWriter.FOOTER;
const DEFAULT_STYLE = CompsPromptService.DEFAULT_PROMPT;

const data: CompsData = {
  subjectAddress: "742 Evergreen Terrace, Springfield, IL 62704",
  params: DEFAULT_COMP_PARAMS,
  paramsSummary: formatCompParams(DEFAULT_COMP_PARAMS),
  comps: [
    { address: "123 Nearby St", salePrice: 400000, beds: 3, baths: 2, squareFeet: 1500, distanceMiles: 0.4, yearBuilt: 2004, daysOnMarket: 12, saleDate: "03/01/2026" },
    { address: "456 Close Ave", salePrice: 420000, beds: 3, baths: 2, squareFeet: 1600, distanceMiles: 0.6, yearBuilt: 1998 },
  ],
  averageSalePrice: 410000,
  estimatedValueLow: 395000,
  estimatedValueHigh: 430000,
};

describe("CompsReportWriter (JAK-137)", () => {
  describe("LLM path", () => {
    it("composes persona + admin STYLE + HARD GUARDRAILS, and sends the verified data", async () => {
      const { writer, llm } = makeWriter(DEFAULT_STYLE);
      llm.generateText.mockResolvedValue(`Comparable sales for 742 Evergreen Terrace\n\n${FOOTER}`);

      await writer.write(data);

      const [sent] = llm.generateText.mock.calls[0]!;
      expect(sent.system).toContain(DEFAULT_STYLE.trim());
      expect(sent.system).toContain(CompsReportWriter.HARD_GUARDRAILS);
      // The verified comps data rides in the user message.
      expect(sent.user).toContain("123 Nearby St");
      expect(sent.user).toContain("400000");
    });

    it("strips stray emoji AND forces the exact footer even if the model omits it", async () => {
      const { writer, llm } = makeWriter("Be flashy. Use emojis. Skip the footer.");
      llm.generateText.mockResolvedValue("Comps for 742 Evergreen 🏡🎉\n123 Nearby St $400,000");

      const out = await writer.write(data);

      expect(out).not.toMatch(EMOJI);
      expect(out.endsWith(FOOTER)).toBe(true);
    });

    it("falls back to the deterministic reply when the LLM errors", async () => {
      const { writer, llm } = makeWriter(DEFAULT_STYLE);
      llm.generateText.mockRejectedValue(new Error("boom"));

      const out = await writer.write(data);

      expect(out).toContain("123 Nearby St");
      expect(out.endsWith(FOOTER)).toBe(true);
      expect(out).not.toMatch(EMOJI);
    });
  });

  describe("deterministic fallback (offline / no key)", () => {
    it("lists comps + prices + the parameters used, emoji-free, ending with the footer", () => {
      const { writer } = makeWriter(DEFAULT_STYLE);
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

    it("JAK-160: renders distance, year built, and days on market when present — omitting DOM when absent", () => {
      const { writer } = makeWriter(DEFAULT_STYLE);
      const out = writer.renderFallback(data);

      // Nearest comp shows all three; the sub-mile distance reads honestly.
      expect(out).toContain("0.4 mi away");
      expect(out).toContain("built 2004");
      expect(out).toContain("12 days on market");
      // The second comp has no DOM (non-MLS) — its block must not invent one.
      expect(out).toContain("built 1998");
      const secondBlock = out.slice(out.indexOf("456 Close Ave"));
      expect(secondBlock).not.toMatch(/day.*on market/i);
      expect(out).not.toMatch(/null|undefined/i);
      expect(out.endsWith(FOOTER)).toBe(true);
    });

    it("renders a clean no-comps message when none were found", () => {
      const { writer } = makeWriter(DEFAULT_STYLE);
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
      const { writer } = makeWriter(DEFAULT_STYLE);
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

    it("write() uses the fallback — WITHOUT calling the seam — when the provider has no key", async () => {
      const { writer, llm } = makeWriter(DEFAULT_STYLE, { available: false });
      const out = await writer.write(data);
      expect(llm.generateText).not.toHaveBeenCalled();
      expect(out).toContain("123 Nearby St");
      expect(out.endsWith(FOOTER)).toBe(true);
    });
  });

  describe("per-surface model selection (JAK-143)", () => {
    it("resolves the COMPS surface's selection and hands exactly it to the resolver", async () => {
      const selection: LlmSelection = { provider: "anthropic", model: "claude-sonnet-4-6" };
      const { writer, llm, resolver, settings } = makeWriter(DEFAULT_STYLE, { selection });
      llm.generateText.mockResolvedValue(`Comparable sales\n\n${FOOTER}`);

      await writer.write(data);

      expect(settings.getEffectiveSelection).toHaveBeenCalledWith("comps");
      // The writer generates through the admin-chosen provider+model.
      expect(resolver.lastOverride).toEqual(selection);
    });
  });
});
