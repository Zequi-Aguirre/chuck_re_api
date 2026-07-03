import { SkipTraceReportWriter } from "../SkipTraceReportWriter";
import { SkipTracePromptService } from "../SkipTracePromptService";
import { LlmClient } from "../../llm/LlmClient";
import { LlmClientResolver } from "../../llm/LlmClientResolver";
import { LlmModelSettingsService } from "../../llm/LlmModelSettingsService";
import { LlmSelection, LlmSelectionOverride } from "../../llm/LlmSelection";
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

/** A stub settings service returning a fixed effective selection for the skip-trace surface. */
const settingsReturning = (
  selection: LlmSelection = { provider: "openai", model: "gpt-4o" }
): LlmModelSettingsService =>
  ({ getEffectiveSelection: jest.fn().mockResolvedValue(selection) } as unknown as LlmModelSettingsService);

/** Build a REAL writer with a fake LLM seam; returns both so tests can drive/inspect the seam. */
const makeWriter = (
  style: string,
  opts: { available?: boolean; selection?: LlmSelection } = {}
): { writer: SkipTraceReportWriter; llm: FakeLlm; resolver: ReturnType<typeof resolverFor>; settings: LlmModelSettingsService } => {
  const llm = new FakeLlm();
  if (opts.available === false) llm.isAvailable = false;
  const resolver = resolverFor(llm);
  const settings = settingsReturning(opts.selection);
  return { writer: new SkipTraceReportWriter(resolver, settings, promptServiceReturning(style)), llm, resolver, settings };
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

  describe("grouped-by-person formatting (JAK-145)", () => {
    // Fictional personas only (no real PII): the property owner is looked up, the
    // trace returns two different address-linked residents, each with their own info.
    const grouped: SkipTraceData = {
      targetAddress: "742 Evergreen Terrace, Springfield, IL 62704",
      requestedName: "Homer Simpson",
      persons: [
        {
          name: "Ned Flanders",
          phones: ["+1 555 010 0001", "+1 555 010 0002"],
          emails: ["ned@example.com"],
        },
        {
          name: "Maude Flanders",
          phones: ["+1 555 010 0003"],
          emails: ["maude@example.com", "maude2@example.com"],
        },
      ],
    };

    it("renders each PERSON with THEIR OWN phones/emails, names next to the numbers", () => {
      const { writer } = makeWriter(DEFAULT_STYLE);
      const out = writer.renderFallback(grouped);

      // Both people appear, each name leading its own contact block.
      expect(out).toContain("Ned Flanders");
      expect(out).toContain("Maude Flanders");
      // Each person's number is grouped under THEIR name (name precedes their phone).
      expect(out.indexOf("Ned Flanders")).toBeLessThan(out.indexOf("+1 555 010 0001"));
      expect(out.indexOf("+1 555 010 0001")).toBeLessThan(out.indexOf("Maude Flanders"));
      expect(out.indexOf("Maude Flanders")).toBeLessThan(out.indexOf("+1 555 010 0003"));
      // Honest header: who we looked up + the property.
      expect(out).toContain("742 Evergreen Terrace");
      expect(out).toContain("Homer Simpson");
      expect(out.endsWith(FOOTER)).toBe(true);
      expect(out).not.toMatch(EMOJI);
    });

    it("hands the grouped persons to the LLM so it can present them by person", async () => {
      const { writer, llm } = makeWriter(DEFAULT_STYLE);
      llm.generateText.mockResolvedValue(`Contacts\n\n${FOOTER}`);

      await writer.write(grouped, { match: true });

      const [sent] = llm.generateText.mock.calls[0]!;
      expect(sent.user).toContain("Ned Flanders");
      expect(sent.user).toContain("Maude Flanders");
      expect(sent.user).toContain("+1 555 010 0003");
    });
  });

  describe("per-surface model selection (JAK-143)", () => {
    it("resolves the SKIPTRACE surface's selection and hands exactly it to the resolver", async () => {
      const selection: LlmSelection = { provider: "anthropic", model: "claude-sonnet-4-6" };
      const { writer, llm, resolver, settings } = makeWriter(DEFAULT_STYLE, { selection });
      llm.generateText.mockResolvedValue(`Owner: Homer Simpson\n\n${FOOTER}`);

      await writer.write(data, { match: true });

      expect(settings.getEffectiveSelection).toHaveBeenCalledWith("skiptrace");
      expect(resolver.lastOverride).toEqual(selection);
    });
  });
});
