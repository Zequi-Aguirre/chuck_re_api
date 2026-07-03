import { AnthropicRouterLlmClient, RouterClassifyRequest } from "../RouterLlmClient";
import { EnvConfig } from "../../../config/envConfig";

/**
 * The router's LLM seam (JAK-135). The production client talks to Claude, but two
 * things must hold WITHOUT the network:
 *   - dev / no-key: it falls back to a deterministic classification and makes NO
 *     Anthropic call and NO paid spend (address→report, OK→refresh, else chitchat);
 *   - when the model DOES answer, its structured JSON is parsed + validated.
 * A test subclass overrides the single protected `generateWithLlm` seam so we
 * exercise parsing without a real API call.
 */
describe("AnthropicRouterLlmClient (JAK-135 router LLM)", () => {
  const req = (over: Partial<RouterClassifyRequest> = {}): RouterClassifyRequest => ({
    systemPrompt: "STYLE",
    message: "hi",
    parsedAddress: null,
    isAffirmative: false,
    recentMessages: [],
    resolvedAddresses: [],
    ...over,
  });

  const envWith = (anthropicApiKey: string): EnvConfig =>
    ({ anthropicApiKey, anthropicModel: "claude-opus-4-8" } as unknown as EnvConfig);

  describe("deterministic fallback (no key → no network, no spend)", () => {
    // A subclass that would EXPLODE if the network path were taken — proving the
    // fallback never builds a client or calls the API when the key is unset.
    class ExplodingClient extends AnthropicRouterLlmClient {
      protected client(): never {
        throw new Error("client() must not be called when the key is unset");
      }
    }
    const client = () => new ExplodingClient(envWith(""));

    it("a parseable address → property_report on it", async () => {
      const out = await client().classify(req({ parsedAddress: "123 Main St, Springfield, IL 62704" }));
      expect(out).toEqual({
        intent: "property_report",
        targetAddress: "123 Main St, Springfield, IL 62704",
        addressOrdinal: null,
        userFacingNote: "",
      });
    });

    it("a bare affirmative → report_refresh", async () => {
      const out = await client().classify(req({ isAffirmative: true }));
      expect(out.intent).toBe("report_refresh");
    });

    it("anything else → chitchat", async () => {
      const out = await client().classify(req({ message: "hey there" }));
      expect(out.intent).toBe("chitchat");
    });
  });

  describe("structured-output parsing", () => {
    class StubClient extends AnthropicRouterLlmClient {
      constructor(private readonly raw: string) {
        // A non-empty placeholder so the non-fallback path is taken; the network
        // seam (generateWithLlm) is overridden below, so no client is ever built.
        super(envWith("router-test-key-unused"));
      }
      protected async generateWithLlm(): Promise<string> {
        return this.raw;
      }
    }

    it("parses + validates a well-formed classification", async () => {
      const out = await new StubClient(
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

    it("keeps a valid ordinal reference", async () => {
      const out = await new StubClient(
        JSON.stringify({ intent: "property_report", targetAddress: null, addressOrdinal: 2, userFacingNote: "" })
      ).classify(req());
      expect(out.addressOrdinal).toBe(2);
    });

    it("extracts texter comp-parameter overrides for a comps request (JAK-137)", async () => {
      const out = await new StubClient(
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
      const withGarbage = await new StubClient(
        JSON.stringify({
          intent: "comps",
          targetAddress: "9 New St, Town, CA 90000",
          addressOrdinal: null,
          userFacingNote: "",
          compParams: { count: 4, radiusMiles: "close", nonsense: 7 },
        })
      ).classify(req());
      expect(withGarbage.compParams).toEqual({ count: 4 });

      const none = await new StubClient(
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
      const out = await new StubClient(
        JSON.stringify({ intent: "banana", targetAddress: null, addressOrdinal: null, userFacingNote: "" })
      ).classify(req({ isAffirmative: true }));
      expect(out.intent).toBe("report_refresh"); // fell back, didn't trust "banana"
    });

    it("non-JSON output falls back deterministically", async () => {
      const out = await new StubClient("sorry, I can't do that").classify(
        req({ parsedAddress: "5 Fallback Ave, Town, CA 90000" })
      );
      expect(out.intent).toBe("property_report");
      expect(out.targetAddress).toBe("5 Fallback Ave, Town, CA 90000");
    });
  });

  it("composes the system prompt with the admin style AND the always-on hard rules", () => {
    const composed = new AnthropicRouterLlmClient(envWith("")).composeSystemPrompt("BE TERSE");
    expect(composed).toContain("BE TERSE");
    expect(composed).toContain("HARD RULES");
    expect(composed).toContain("property_report");
    // Hard rules come LAST so they control.
    expect(composed.indexOf("HARD RULES")).toBeGreaterThan(composed.indexOf("BE TERSE"));
  });
});
