import { GhlApiError } from "../../api/GhlApiClient";
import { classifyFailure, redactSecrets, summarizeError } from "../EnrichmentFailure";

describe("EnrichmentFailure", () => {
  describe("classifyFailure", () => {
    it("treats a GHL 429 as transient (retry)", () => {
      expect(classifyFailure(new GhlApiError("rate limited", 429)).kind).toBe("transient");
    });

    it("treats a GHL 5xx as transient (retry)", () => {
      expect(classifyFailure(new GhlApiError("server error", 503)).kind).toBe("transient");
    });

    it("treats a network error (no status) as transient (retry)", () => {
      expect(classifyFailure(new GhlApiError("ECONNRESET")).kind).toBe("transient");
    });

    it("treats a GHL 4xx as permanent (fail fast)", () => {
      expect(classifyFailure(new GhlApiError("bad request", 400)).kind).toBe("permanent");
      expect(classifyFailure(new GhlApiError("not found", 404)).kind).toBe("permanent");
    });

    it("treats a non-API error (DB blip) as transient by default", () => {
      expect(classifyFailure(new Error("connection terminated")).kind).toBe("transient");
    });
  });

  describe("summarizeError", () => {
    it("summarizes a GHL API error to its status, not its raw message", () => {
      expect(summarizeError(new GhlApiError("anything", 500))).toBe("GHL 500");
    });

    it("falls back to a plain error message when there is no status", () => {
      expect(summarizeError(new Error("boom"))).toBe("boom");
    });

    it("handles a non-Error throw", () => {
      expect(summarizeError("weird")).toBe("unknown error");
    });

    it("NEVER leaks a bearer token that leaked into an error message", () => {
      // Obviously-fake placeholder token — asserts the redaction, carries no secret.
      const leaked = new Error("request failed: Authorization: Bearer FAKE-TOKEN-PLACEHOLDER-xyz");
      const out = summarizeError(leaked);
      expect(out).not.toContain("FAKE-TOKEN-PLACEHOLDER-xyz");
      expect(out).toContain("Bearer ***");
    });
  });

  describe("redactSecrets", () => {
    it("redacts bearer tokens", () => {
      expect(redactSecrets("Authorization: Bearer FAKE-PLACEHOLDER-token")).toContain("Bearer ***");
    });

    it("redacts key/token/secret assignments", () => {
      const placeholder = "FAKE-PLACEHOLDER-value";
      expect(redactSecrets(`apiKey="${placeholder}"`)).not.toContain(placeholder);
      expect(redactSecrets(`token=${placeholder}`)).not.toContain(placeholder);
    });

    it("leaves innocent text untouched", () => {
      expect(redactSecrets("GHL 500 while writing back")).toBe("GHL 500 while writing back");
    });
  });
});
