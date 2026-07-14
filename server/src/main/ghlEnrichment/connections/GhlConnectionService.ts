import { injectable } from "tsyringe";
import { CredentialCipher } from "./CredentialCipher";
import { GhlConnectionRow, GhlConnectionStore } from "./GhlConnectionStore";
import {
  CreateGhlConnectionInput,
  DEFAULT_TEXT_MODE,
  GhlConnection,
  UpdateGhlConnectionInput,
} from "./GhlConnectionTypes";
import { generateWebhookKey, hashWebhookKey } from "./WebhookKey";

/**
 * The SINGLE source of GHL credentials for the whole app (JAK-102).
 *
 * Wraps {@link GhlConnectionStore} (persistence) and {@link CredentialCipher}
 * (encrypt-at-rest) so callers work in plaintext {@link GhlConnection} values
 * while API keys are only ever stored encrypted. This service abstracts "how we
 * auth to a sub-account": today it's a pasted API key (beta), later an OAuth
 * token — callers (enrichment webhook, text-Jake JAK-114) don't care which.
 *
 * Credentials live per-location in the DB (encrypted at rest); Doppler keeps
 * only the app-level encryption key, never a tenant's GHL API key or base URL.
 */
@injectable()
export class GhlConnectionService {
  constructor(
    private readonly store: GhlConnectionStore,
    private readonly cipher: CredentialCipher
  ) {}

  /** Create a connection, encrypting the API key before it touches the DB. */
  async createConnection(input: CreateGhlConnectionInput): Promise<GhlConnection> {
    // JAK-189: mint a per-location inbound webhook key up front so a new connection
    // is never keyless. Store its hash (lookup) + encrypted form (admin display).
    const webhookKey = generateWebhookKey();
    const row = await this.store.insert({
      location_id: input.locationId,
      name: input.name ?? null,
      api_key_encrypted: this.cipher.encrypt(input.apiKey),
      base_url: input.baseUrl,
      phone_numbers: input.phoneNumbers ?? [],
      status: input.status ?? "active",
      text_mode: input.textMode ?? DEFAULT_TEXT_MODE,
      // JAK-186: opt-in — a new connection is NOT auto-enriched until turned on.
      auto_enrichment_enabled: input.autoEnrichmentEnabled ?? false,
      // JAK-191: normal metering by default — unlimited is opt-in.
      unlimited_credits: input.unlimitedCredits ?? false,
      webhook_key_hash: hashWebhookKey(webhookKey),
      webhook_key_enc: this.cipher.encrypt(webhookKey),
    });
    return this.toConnection(row);
  }

  /** Resolve a connection by GHL location id (enrichment webhook path). */
  async getByLocationId(locationId: string): Promise<GhlConnection | null> {
    const row = await this.store.findByLocationId(locationId);
    return row ? this.toConnection(row) : null;
  }

  /**
   * Resolve a connection by a PRESENTED inbound webhook key (JAK-189) — the auth
   * lookup for POST /ghl/contact-created. Hashes the key and finds the location
   * whose stored hash matches; null when no location owns that key.
   */
  async getByWebhookKey(presentedKey: string): Promise<GhlConnection | null> {
    const row = await this.store.findByWebhookKeyHash(hashWebhookKey(presentedKey));
    return row ? this.toConnection(row) : null;
  }

  /**
   * The DECRYPTED webhook key for a location, for the admin UI to display/copy
   * (JAK-189). Null when the location is unknown or (transiently) has no key yet.
   */
  async getWebhookKey(locationId: string): Promise<string | null> {
    const row = await this.store.findByLocationId(locationId);
    if (!row || !row.webhook_key_enc) return null;
    return this.cipher.decrypt(row.webhook_key_enc);
  }

  /**
   * Rotate a location's webhook key (JAK-189): mint a fresh key, replace BOTH the
   * hash and the encrypted copy, and return the new plaintext key (shown once to
   * the admin). The old key stops authenticating immediately. Null if unknown.
   */
  async regenerateWebhookKey(locationId: string): Promise<string | null> {
    const newKey = generateWebhookKey();
    const row = await this.store.update(locationId, {
      webhook_key_hash: hashWebhookKey(newKey),
      webhook_key_enc: this.cipher.encrypt(newKey),
    });
    return row ? newKey : null;
  }

  /**
   * Backfill a webhook key onto every connection missing one (JAK-189) — the
   * one-time, idempotent boot step the migration defers to (SQL can't run the
   * app-level cipher). Covers active AND inactive connections. Returns how many
   * were filled; a no-op (returns 0) once every row has a key.
   */
  async ensureWebhookKeys(): Promise<number> {
    const missing = await this.store.listMissingWebhookKey();
    let filled = 0;
    for (const row of missing) {
      const key = generateWebhookKey();
      await this.store.update(row.location_id, {
        webhook_key_hash: hashWebhookKey(key),
        webhook_key_enc: this.cipher.encrypt(key),
      });
      filled++;
    }
    return filled;
  }

  /** Resolve a connection by an associated phone number (text-Jake routing). */
  async getByPhoneNumber(phoneNumber: string): Promise<GhlConnection | null> {
    const row = await this.store.findByPhoneNumber(phoneNumber);
    return row ? this.toConnection(row) : null;
  }

  /** List every connection (decrypted). For admin/CRUD use (JAK-113). */
  async listConnections(): Promise<GhlConnection[]> {
    const rows = await this.store.listAll();
    return rows.map((row) => this.toConnection(row));
  }

  /**
   * Update a connection by location id. A provided `apiKey` is re-encrypted;
   * omit it to keep the stored key. Returns null if the location is unknown.
   */
  async updateConnection(
    locationId: string,
    patch: UpdateGhlConnectionInput
  ): Promise<GhlConnection | null> {
    const row = await this.store.update(locationId, {
      name: patch.name,
      api_key_encrypted:
        patch.apiKey !== undefined ? this.cipher.encrypt(patch.apiKey) : undefined,
      base_url: patch.baseUrl,
      phone_numbers: patch.phoneNumbers,
      status: patch.status,
      text_mode: patch.textMode,
      auto_enrichment_enabled: patch.autoEnrichmentEnabled,
      unlimited_credits: patch.unlimitedCredits,
    });
    return row ? this.toConnection(row) : null;
  }

  /** Delete a connection by location id. Returns true if one was removed. */
  async deleteConnection(locationId: string): Promise<boolean> {
    return this.store.delete(locationId);
  }

  /** Map a persistence row to a decrypted domain object. */
  private toConnection(row: GhlConnectionRow): GhlConnection {
    return {
      id: row.id,
      locationId: row.location_id,
      name: row.name ?? null,
      apiKey: this.cipher.decrypt(row.api_key_encrypted),
      baseUrl: row.base_url,
      phoneNumbers: row.phone_numbers ?? [],
      status: row.status,
      textMode: row.text_mode ?? DEFAULT_TEXT_MODE,
      autoEnrichmentEnabled: row.auto_enrichment_enabled ?? false,
      unlimitedCredits: row.unlimited_credits ?? false,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
