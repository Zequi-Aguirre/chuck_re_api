import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";
import { injectable } from "tsyringe";
import { GhlEnrichmentConfig } from "../config/GhlEnrichmentConfig";

/**
 * Symmetric encryption for per-location GHL credentials at rest (JAK-102).
 *
 * Tenant API keys must NEVER be stored in plaintext (secret-storage rule). This
 * cipher encrypts with AES-256-GCM, which is authenticated — decryption fails
 * loudly if the ciphertext or auth tag is tampered with.
 *
 * The 256-bit key is derived (SHA-256) from the app-level
 * `GHL_CREDENTIAL_ENC_KEY` in Doppler, so operators can supply any sufficiently
 * strong passphrase/hex/base64 value without worrying about exact byte length.
 * Only this app-level key lives in Doppler — never a tenant's own GHL key.
 *
 * Serialized form (single string stored in one text column):
 *   v1:<iv-base64>:<authTag-base64>:<ciphertext-base64>
 * The `v1` prefix lets us rotate schemes/keys later without ambiguity.
 */
@injectable()
export class CredentialCipher {
  private static readonly VERSION = "v1";
  private static readonly ALGORITHM = "aes-256-gcm";
  private static readonly IV_BYTES = 12; // 96-bit nonce, GCM standard

  constructor(private readonly config: GhlEnrichmentConfig) {}

  /** Derive a stable 32-byte key from the configured secret. */
  private deriveKey(): Uint8Array {
    const secret = this.config.credentialEncryptionKey?.trim();
    if (!secret) {
      throw new Error(
        "GHL_CREDENTIAL_ENC_KEY is not configured — cannot encrypt/decrypt " +
          "connection credentials."
      );
    }
    return Uint8Array.from(createHash("sha256").update(secret, "utf8").digest());
  }

  /** Encrypt plaintext (e.g. a GHL API key) into the serialized `v1:...` form. */
  encrypt(plaintext: string): string {
    const iv = Uint8Array.from(randomBytes(CredentialCipher.IV_BYTES));
    const cipher = createCipheriv(CredentialCipher.ALGORITHM, this.deriveKey(), iv);
    const ciphertext =
      cipher.update(plaintext, "utf8", "base64") + cipher.final("base64");
    const authTag = cipher.getAuthTag();
    return [
      CredentialCipher.VERSION,
      Buffer.from(iv).toString("base64"),
      authTag.toString("base64"),
      ciphertext,
    ].join(":");
  }

  /** Decrypt a serialized `v1:...` string back to plaintext. */
  decrypt(serialized: string): string {
    const parts = serialized.split(":");
    if (parts.length !== 4 || parts[0] !== CredentialCipher.VERSION) {
      throw new Error("Unrecognized encrypted credential format.");
    }
    const [, ivB64, tagB64, dataB64] = parts;
    const decipher = createDecipheriv(
      CredentialCipher.ALGORITHM,
      this.deriveKey(),
      Uint8Array.from(Buffer.from(ivB64, "base64"))
    );
    decipher.setAuthTag(Uint8Array.from(Buffer.from(tagB64, "base64")));
    return decipher.update(dataB64, "base64", "utf8") + decipher.final("utf8");
  }
}
