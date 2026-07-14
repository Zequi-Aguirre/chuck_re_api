import {
  generateWebhookKey,
  hashWebhookKey,
  isWebhookKeyShaped,
  WEBHOOK_KEY_PREFIX,
} from "../WebhookKey";

describe("WebhookKey (JAK-189)", () => {
  it("generates a prefixed, high-entropy key", () => {
    const key = generateWebhookKey();
    expect(key.startsWith(WEBHOOK_KEY_PREFIX)).toBe(true);
    // jakewh_ + 32 bytes as hex = 64 hex chars.
    expect(key).toMatch(/^jakewh_[0-9a-f]{64}$/);
  });

  it("generates a UNIQUE key each call (crypto RNG, not a constant)", () => {
    const keys = new Set(Array.from({ length: 100 }, () => generateWebhookKey()));
    expect(keys.size).toBe(100);
  });

  it("hashes deterministically to SHA-256 hex", () => {
    const key = generateWebhookKey();
    expect(hashWebhookKey(key)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashWebhookKey(key)).toBe(hashWebhookKey(key));
  });

  it("hash tolerates surrounding whitespace (header padding)", () => {
    const key = generateWebhookKey();
    expect(hashWebhookKey(`  ${key}\n`)).toBe(hashWebhookKey(key));
  });

  it("different keys hash to different values", () => {
    expect(hashWebhookKey(generateWebhookKey())).not.toBe(hashWebhookKey(generateWebhookKey()));
  });

  it("recognizes a key-shaped value", () => {
    expect(isWebhookKeyShaped(generateWebhookKey())).toBe(true);
    expect(isWebhookKeyShaped("some-master-key")).toBe(false);
    expect(isWebhookKeyShaped(WEBHOOK_KEY_PREFIX)).toBe(false); // prefix only, no tail
  });
});
