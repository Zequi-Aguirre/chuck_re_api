import { randomUUID } from "crypto";
import { CredentialCipher } from "../CredentialCipher";
import { GhlEnrichmentConfig } from "../../config/GhlEnrichmentConfig";

/** Build a cipher with a fixed encryption key, bypassing Doppler/DI. */
const cipherWithKey = (key: string): CredentialCipher =>
  new CredentialCipher({ credentialEncryptionKey: key } as GhlEnrichmentConfig);

describe("CredentialCipher", () => {
  const cipher = cipherWithKey("test-encryption-key-please-rotate");

  it("round-trips plaintext through encrypt/decrypt", () => {
    // Shape-matches a GHL Private Integration Token (`pit-<uuid>`) but is
    // generated at runtime, so nothing secret-looking is ever committed.
    const secret = `pit-${randomUUID()}`;
    const encrypted = cipher.encrypt(secret);
    expect(cipher.decrypt(encrypted)).toBe(secret);
  });

  it("never emits the plaintext in the serialized form", () => {
    const secret = "super-secret-api-key";
    const encrypted = cipher.encrypt(secret);
    expect(encrypted).not.toContain(secret);
    expect(encrypted.startsWith("v1:")).toBe(true);
  });

  it("produces distinct ciphertext each call (random IV) but decrypts equally", () => {
    const secret = "same-input";
    const a = cipher.encrypt(secret);
    const b = cipher.encrypt(secret);
    expect(a).not.toBe(b);
    expect(cipher.decrypt(a)).toBe(secret);
    expect(cipher.decrypt(b)).toBe(secret);
  });

  it("handles unicode and empty strings", () => {
    for (const secret of ["", "🔑 clé — ключ", "a".repeat(2000)]) {
      expect(cipher.decrypt(cipher.encrypt(secret))).toBe(secret);
    }
  });

  it("rejects tampered ciphertext (GCM auth tag)", () => {
    const encrypted = cipher.encrypt("value");
    const parts = encrypted.split(":");
    // Flip a byte in the ciphertext segment.
    const data = Buffer.from(parts[3], "base64");
    data[0] ^= 0xff;
    parts[3] = data.toString("base64");
    expect(() => cipher.decrypt(parts.join(":"))).toThrow();
  });

  it("rejects an unrecognized format", () => {
    expect(() => cipher.decrypt("not-a-valid-blob")).toThrow(
      /Unrecognized encrypted credential format/
    );
  });

  it("fails to decrypt with the wrong key", () => {
    const encrypted = cipher.encrypt("value");
    const other = cipherWithKey("a-completely-different-key");
    expect(() => other.decrypt(encrypted)).toThrow();
  });

  it("throws when no encryption key is configured", () => {
    const keyless = cipherWithKey("");
    expect(() => keyless.encrypt("x")).toThrow(/GHL_CREDENTIAL_ENC_KEY/);
  });
});
