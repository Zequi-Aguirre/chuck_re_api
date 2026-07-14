import { createHash, randomBytes } from "crypto";

/**
 * Per-sub-account inbound webhook API key (JAK-189, epic JAK-180).
 *
 * Each connection gets its OWN key that authenticates POST /ghl/contact-created,
 * so a leaked key exposes only that one sub-account (never the shared
 * MASTER_API_KEY). The key is:
 *   - GENERATED with a crypto-secure RNG (`jakewh_` + 32 random bytes as hex);
 *   - HASHED (SHA-256, hex) for O(1) inbound lookup — the hash is what's indexed,
 *     so the DB never holds a value that could be replayed as a key;
 *   - stored ALSO encrypted (via the JAK-102 CredentialCipher, elsewhere) so the
 *     admin UI can display/copy the real key back to the sub-account owner.
 */

/** Human-readable prefix so a leaked key is instantly recognizable in logs/support. */
export const WEBHOOK_KEY_PREFIX = "jakewh_";

/** Random bytes behind the prefix (32 bytes → 64 hex chars → 256 bits of entropy). */
const WEBHOOK_KEY_RANDOM_BYTES = 32;

/** Generate a fresh, crypto-secure webhook key: `jakewh_<64 hex chars>`. */
export function generateWebhookKey(): string {
  return WEBHOOK_KEY_PREFIX + randomBytes(WEBHOOK_KEY_RANDOM_BYTES).toString("hex");
}

/**
 * SHA-256 (hex) of a webhook key — the value stored + indexed for inbound lookup.
 * Deterministic, so the presented key hashes to the same value we resolve the
 * location by. Trimmed so surrounding whitespace from a header never breaks a match.
 */
export function hashWebhookKey(key: string): string {
  return createHash("sha256").update(key.trim(), "utf8").digest("hex");
}

/** True when a value looks like one of our webhook keys (prefix + non-empty tail). */
export function isWebhookKeyShaped(value: string): boolean {
  return value.startsWith(WEBHOOK_KEY_PREFIX) && value.length > WEBHOOK_KEY_PREFIX.length;
}
