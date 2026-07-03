import { LlmRouterClient, RouterClassifyRequest } from "../RouterLlmClient";
import { LlmClient, LlmStructuredRequest } from "../../llm/LlmClient";

/**
 * The router's LLM seam (JAK-135), now provider-agnostic (JAK-141). It classifies
 * through the shared {@link LlmClient} structured-output seam — OpenAI or Anthropic,
 * whichever LLM_PROVIDER selects — but two things must hold WITHOUT the network:
 *   - no key for the selected provider (isAvailable=false): it falls back to a
 *     deterministic classification and NEVER touches the LLM seam (no call, no
 *     spend) — address→report, OK→refresh, else chitchat;
 *   - when the model DOES answer, its structured JSON is parsed + validated.
 * A fake LlmClient stands in for the seam so we exercise both paths offline.
 */
describe("LlmRouterClient (JAK-135 router LLM, JAK-141 provider-agnostic)", () => {
  const req = (over: Partial<RouterClassifyRequest> = {}): RouterClassifyRequest => ({
    systemPrompt: "STYLE",
    message: "hi",
    parsedAddress: null,
    isAffirmative: false,
    recentMessages: [],
    resolvedAddresses: [],
    ...over,
  });

  /** A fake LlmClient with no network — controls availability + the structured reply. */
  class FakeLlm implements LlmClient {
    readonly provider = "fake";
    lastRequest?: LlmStructuredRequest;
    constructor(
      readonly isAvailable: boolean,
      private readonly reply: string | (() => never)
    ) {}
    async generateText(): Promise<string> {
      throw new Error("the router uses generateStructured, not generateText");
    }
    async generateStructured(r: LlmStructuredRequest): Promise<string> {
      this.lastRequest = r;
      return typeof this.reply === "function" ? this.reply() : this.reply;
    }
  }

  describe("deterministic fallback (no key → no network, no spend)", () => {
    // isAvailable=false + a seam that EXPLODES if called — proves the fallback
    // never reaches the LLM when the selected provider has no key.
    const make = () => {
      const llm = new FakeLlm(false, () => {
        throw new Error("generateStructured must not be called when the key is unset");
      });
      return { client: new LlmRouterClient(llm), llm };
    };

    it("a parseable address → property_report on it", async () => {
      const { client, llm } = make();
      const out = await client.classify(req({ parsedAddress: "123 Main St, Springfield, IL 62704" }));
      expect(out).toEqual({
        intent: "property_report",
        targetAddress: "123 Main St, Springfield, IL 62704",
        addressOrdinal: null,
        userFacingNote: "",
      });
      expect(llm.lastRequest).toBeUndefined(); // never hit the network seam
    });

    it("a bare affirmative → report_refresh", async () => {
      const { client } = make();
      const out = await client.classify(req({ isAffirmative: true }));
      expect(out.intent).toBe("report_refresh");
    });

    it("anything else → chitchat", async () => {
      const { client } = make();
      const out = await client.classify(req({ message: "hey there" }));
      expect(out.intent).toBe("chitchat");
    });
  });

  describe("structured-output parsing", () => {
    const withReply = (raw: string) => new LlmRouterClient(new FakeLlm(true, raw));

    it("parses + validates a well-formed classification", async () => {
      const out = await withReply(
        JSON.stringify({
          intent: "property_report",
          targetAddress: "9 New St, Town, CA 90000",
          addressOrdinal: null,
          userFacingNote: "Pulling that up.",
        })
      ).classify(req({ parsedAddress: "9 New St, Town, CA 90000" }));

      expect(out).toEqual({
        intent: "property_report",
        targetAddress: "9 New St, Town, CA 90000",
        addressOrdinal: null,
        userFacingNote: "Pulling that up.",
      });
    });

    it("sends the composed prompt + the classification schema to the structured seam", async () => {
      const llm = new FakeLlm(
        true,
        JSON.stringify({ intent: "chitchat", targetAddress: null, addressOrdinal: null, userFacingNote: "" })
      );
      await new LlmRouterClient(llm).classify(req({ systemPrompt: "BE TERSE", message: "yo" }));

      expect(llm.lastRequest).toBeDefined();
      expect(llm.lastRequest!.system).toContain("BE TERSE");
      expect(llm.lastRequest!.system).toContain("HARD RULES");
      expect(llm.lastRequest!.user).toContain("yo");
      expect(llm.lastRequest!.schemaName).toBe("router_classification");
      // The schema constrains the intent to the known set.
      const props = (llm.lastRequest!.schema as any).properties;
      expect(props.intent.enum).toContain("comps");
    });

    it("keeps a valid ordinal reference", async () => {
      const out = await withReply(
        JSON.stringify({ intent: "property_report", targetAddress: null, addressOrdinal: 2, userFacingNote: "" })
      ).classify(req());
      expect(out.addressOrdinal).toBe(2);
    });

    it("extracts texter comp-parameter overrides for a comps request (JAK-137)", async () => {
      const out = await withReply(
        JSON.stringify({
          intent: "comps",
          targetAddress: "9 New St, Town, CA 90000",
          addressOrdinal: null,
          userFacingNote: "",
          compParams: { radiusMiles: 1, monthsBack: 6, count: 3 },
        })
      ).classify(req({ parsedAddress: "9 New St, Town, CA 90000" }));

      expect(out.intent).toBe("comps");
      expect(out.compParams).toEqual({ radiusMiles: 1, monthsBack: 6, count: 3 });
    });

    it("drops non-numeric / unknown comp-parameter fields, and omits compParams when none usable", async () => {
      const withGarbage = await withReply(
        JSON.stringify({
          intent: "comps",
          targetAddress: "9 New St, Town, CA 90000",
          addressOrdinal: null,
          userFacingNote: "",
          compParams: { count: 4, radiusMiles: "close", nonsense: 7 },
        })
      ).classify(req());
      expect(withGarbage.compParams).toEqual({ count: 4 });

      const none = await withReply(
        JSON.stringify({
          intent: "comps",
          targetAddress: null,
          addressOrdinal: null,
          userFacingNote: "",
          compParams: null,
        })
      ).classify(req());
      expect(none.compParams).toBeUndefined();
    });

    it("an unknown intent falls back to the deterministic classification", async () => {
      const out = await withReply(
        JSON.stringify({ intent: "banana", targetAddress: null, addressOrdinal: null, userFacingNote: "" })
      ).classify(req({ isAffirmative: true }));
      expect(out.intent).toBe("report_refresh"); // fell back, didn't trust "banana"
    });

    it("non-JSON output falls back deterministically", async () => {
      const out = await withReply("sorry, I can't do that").classify(
        req({ parsedAddress: "5 Fallback Ave, Town, CA 90000" })
      );
      expect(out.intent).toBe("property_report");
      expect(out.targetAddress).toBe("5 Fallback Ave, Town, CA 90000");
    });

    it("a thrown/errored call falls back deterministically", async () => {
      const llm = new FakeLlm(true, () => {
        throw new Error("provider 500");
      });
      const out = await new LlmRouterClient(llm).classify(req({ isAffirmative: true }));
      expect(out.intent).toBe("report_refresh");
    });
  });

  it("composes the system prompt with the admin style AND the always-on hard rules", () => {
    const composed = new LlmRouterClient(new FakeLlm(true, "{}")).composeSystemPrompt("BE TERSE");
    expect(composed).toContain("BE TERSE");
    expect(composed).toContain("HARD RULES");
    expect(composed).toContain("property_report");
    // Hard rules come LAST so they control.
    expect(composed.indexOf("HARD RULES")).toBeGreaterThan(composed.indexOf("BE TERSE"));
  });
});
