import { createHmac } from "crypto";
import { GhlEnrichmentConfig } from "../../config/GhlEnrichmentConfig";
import { GhlWebhookVerifier } from "../GhlWebhookVerifier";

// Obviously-fake, generated-looking secret. NOT a real credential.
const FAKE_SECRET = "whsec_fake_unit_test_secret_0000000000";

/** Minimal config stand-in exposing only what the verifier reads. */
const configWith = (over: { webhookSecret?: string; isProduction?: boolean } = {}) =>
  ({
    webhookSecret: over.webhookSecret ?? FAKE_SECRET,
    isProduction: over.isProduction ?? false,
  }) as unknown as GhlEnrichmentConfig;

/** Sign a body with the same HMAC scheme the verifier expects. */
const sign = (body: Buffer, secret = FAKE_SECRET): string =>
  createHmac("sha256", secret).update(Uint8Array.from(body)).digest("hex");

describe("GhlWebhookVerifier", () => {
  const body = Buffer.from(JSON.stringify({ type: "ContactCreate", id: "ct_1" }));

  it("accepts a correctly-signed body", () => {
    const verifier = new GhlWebhookVerifier(configWith());
    expect(verifier.verify(body, sign(body))).toBe("valid");
  });

  it("accepts the GitHub-style `sha256=` prefix", () => {
    const verifier = new GhlWebhookVerifier(configWith());
    expect(verifier.verify(body, `sha256=${sign(body)}`)).toBe("valid");
  });

  it("is case-insensitive on the hex digest", () => {
    const verifier = new GhlWebhookVerifier(configWith());
    expect(verifier.verify(body, sign(body).toUpperCase())).toBe("valid");
  });

  it("rejects a signature computed over a different body", () => {
    const verifier = new GhlWebhookVerifier(configWith());
    const otherSig = sign(Buffer.from("tampered"));
    expect(verifier.verify(body, otherSig)).toBe("invalid-signature");
  });

  it("rejects a signature made with the wrong secret", () => {
    const verifier = new GhlWebhookVerifier(configWith());
    expect(verifier.verify(body, sign(body, "whsec_fake_wrong_key_1111"))).toBe(
      "invalid-signature"
    );
  });

  it("reports a missing signature header distinctly", () => {
    const verifier = new GhlWebhookVerifier(configWith());
    expect(verifier.verify(body, undefined)).toBe("missing-signature");
    expect(verifier.verify(body, "   ")).toBe("missing-signature");
  });

  it("treats non-hex garbage as an invalid signature, not a crash", () => {
    const verifier = new GhlWebhookVerifier(configWith());
    expect(verifier.verify(body, "not-a-hex-digest!!")).toBe("invalid-signature");
  });

  describe("no secret configured", () => {
    it("fails closed in production", () => {
      const verifier = new GhlWebhookVerifier(
        configWith({ webhookSecret: "", isProduction: true })
      );
      expect(verifier.verify(body, sign(body))).toBe("invalid-signature");
    });

    it("allows-with-warning off-prod (local testing only)", () => {
      const verifier = new GhlWebhookVerifier(
        configWith({ webhookSecret: "", isProduction: false })
      );
      expect(verifier.verify(body, undefined)).toBe("unverified-dev");
    });
  });
});
