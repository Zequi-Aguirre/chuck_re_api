import { createHmac, timingSafeEqual } from "crypto";
import { injectable } from "tsyringe";
import { GhlEnrichmentConfig } from "../config/GhlEnrichmentConfig";

/**
 * Outcome of verifying an inbound webhook signature.
 *  - `valid`           — signature matched the shared secret.
 *  - `missing-signature` — no signature header was sent (reject).
 *  - `invalid-signature` — a signature was sent but did not match (reject).
 *  - `unverified-dev`  — no secret is configured AND we're off-prod, so the
 *                        webhook is accepted UNVERIFIED for local testing. This
 *                        never happens in production, where a missing secret
 *                        fails closed as `invalid-signature`.
 */
export type WebhookVerificationResult =
  | "valid"
  | "missing-signature"
  | "invalid-signature"
  | "unverified-dev";

/**
 * Verifies inbound GHL webhook signatures with the shared secret (JAK-106).
 *
 * This is the enrichment webhook's security boundary. It intentionally does NOT
 * use the MASTER_API_KEY (that guards the text-Jake path) — inbound webhooks are
 * authenticated by an HMAC over the RAW request body keyed on
 * `GHL_WEBHOOK_SECRET` (Doppler). Signing the raw bytes (not the re-serialized
 * JSON) is what makes the check sound, so the receiver captures the raw body.
 *
 * Signature format: HMAC-SHA256, hex-encoded, optionally prefixed `sha256=`
 * (GitHub-style). Comparison is constant-time to avoid leaking the digest.
 *
 * Fail-closed: in production a missing secret rejects everything. Off-prod a
 * missing secret is allowed-with-warning so the receiver can be exercised
 * locally without provisioning the secret (the receiver only enqueues — it never
 * writes to a real GHL sub-account, so SPEC §8 write-safety is unaffected).
 */
@injectable()
export class GhlWebhookVerifier {
  private static readonly ALGORITHM = "sha256";

  constructor(private readonly config: GhlEnrichmentConfig) {}

  verify(rawBody: Buffer, signatureHeader?: string): WebhookVerificationResult {
    const secret = this.config.webhookSecret?.trim();
    if (!secret) {
      if (this.config.isProduction) {
        // Fail closed: never accept an unverifiable webhook in production.
        return "invalid-signature";
      }
      console.warn(
        "⚠️ GHL_WEBHOOK_SECRET not configured — accepting webhook UNVERIFIED (non-prod only)."
      );
      return "unverified-dev";
    }

    const provided = this.normalize(signatureHeader);
    if (!provided) {
      return "missing-signature";
    }

    // Wrap in Uint8Array — @types/node's BinaryLike rejects Buffer directly under
    // strict lib (SharedArrayBuffer variance), the same workaround as CredentialCipher.
    const expected = createHmac(GhlWebhookVerifier.ALGORITHM, secret)
      .update(Uint8Array.from(rawBody))
      .digest("hex");

    return this.timingSafeEqualHex(provided, expected)
      ? "valid"
      : "invalid-signature";
  }

  /** Strip an optional `sha256=` prefix and normalize casing/whitespace. */
  private normalize(signatureHeader?: string): string {
    if (!signatureHeader) return "";
    const trimmed = signatureHeader.trim();
    const withoutPrefix = trimmed.toLowerCase().startsWith("sha256=")
      ? trimmed.slice("sha256=".length)
      : trimmed;
    return withoutPrefix.trim().toLowerCase();
  }

  /**
   * Constant-time compare of two hex digests. Length must match first (a cheap,
   * non-secret check); `timingSafeEqual` requires equal-length buffers.
   */
  private timingSafeEqualHex(provided: string, expected: string): boolean {
    if (provided.length !== expected.length) return false;
    try {
      const a = Uint8Array.from(Buffer.from(provided, "hex"));
      const b = Uint8Array.from(Buffer.from(expected, "hex"));
      if (a.length !== b.length || a.length === 0) return false;
      return timingSafeEqual(a, b);
    } catch {
      // Non-hex input — treat as a mismatch.
      return false;
    }
  }
}
