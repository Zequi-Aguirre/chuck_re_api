import { injectable } from "tsyringe";
import { PostgresDatabase } from "../../data/PostgresDatabase";
import { GhlConnectionStatus, GhlTextMode } from "./GhlConnectionTypes";

/**
 * Raw persistence row for the `ghl_connections` table. `api_key_encrypted`
 * holds the serialized ciphertext — this layer never sees plaintext keys; the
 * {@link GhlConnectionService} owns encrypt/decrypt.
 */
export interface GhlConnectionRow {
  id: string;
  location_id: string;
  /** JAK-190 — friendly admin label; null falls back to the location id in the UI. */
  name: string | null;
  api_key_encrypted: string;
  base_url: string;
  phone_numbers: string[];
  status: GhlConnectionStatus;
  text_mode: GhlTextMode;
  /** JAK-186 — per-location contact-created auto-enrichment toggle (opt-in). */
  auto_enrichment_enabled: boolean;
  /** JAK-191 — when true, the enrichment credit gate never blocks and never
   * decrements for this location. */
  unlimited_credits: boolean;
  /** JAK-189 — SHA-256 (hex) of the per-location inbound webhook key; null until
   * backfilled. Unique + indexed for O(1) inbound lookup. */
  webhook_key_hash: string | null;
  /** JAK-189 — the webhook key encrypted at rest (same cipher as api_key), for the
   * admin UI to display/copy. Null until backfilled. */
  webhook_key_enc: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface InsertGhlConnectionRow {
  location_id: string;
  name: string | null;
  api_key_encrypted: string;
  base_url: string;
  phone_numbers: string[];
  status: GhlConnectionStatus;
  text_mode: GhlTextMode;
  auto_enrichment_enabled: boolean;
  unlimited_credits: boolean;
  webhook_key_hash: string;
  webhook_key_enc: string;
}

export interface UpdateGhlConnectionRow {
  name?: string | null;
  api_key_encrypted?: string;
  base_url?: string;
  phone_numbers?: string[];
  status?: GhlConnectionStatus;
  text_mode?: GhlTextMode;
  webhook_key_hash?: string;
  webhook_key_enc?: string;
  auto_enrichment_enabled?: boolean;
  unlimited_credits?: boolean;
}

/**
 * Data-access layer for per-location GHL connections (JAK-102).
 *
 * Pure SQL over {@link PostgresDatabase} — CRUD plus the two resolvers the
 * product needs: by `location_id` (enrichment webhook path) and by phone number
 * (text-Jake routing, JAK-114). Columns/timestamps follow existing snake_case
 * conventions (`created_at` / `updated_at`, `timestamptz`).
 */
@injectable()
export class GhlConnectionStore {
  constructor(private readonly db: PostgresDatabase) {}

  async insert(row: InsertGhlConnectionRow): Promise<GhlConnectionRow> {
    const result = await this.db.query<GhlConnectionRow>(
      `INSERT INTO ghl_connections
         (location_id, name, api_key_encrypted, base_url, phone_numbers, status, text_mode, auto_enrichment_enabled, unlimited_credits, webhook_key_hash, webhook_key_enc)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        row.location_id,
        row.name,
        row.api_key_encrypted,
        row.base_url,
        row.phone_numbers,
        row.status,
        row.text_mode,
        row.auto_enrichment_enabled,
        row.unlimited_credits,
        row.webhook_key_hash,
        row.webhook_key_enc,
      ]
    );
    return result.rows[0];
  }

  async findByLocationId(locationId: string): Promise<GhlConnectionRow | null> {
    const result = await this.db.query<GhlConnectionRow>(
      `SELECT * FROM ghl_connections WHERE location_id = $1`,
      [locationId]
    );
    return result.rows[0] ?? null;
  }

  /**
   * Resolve the connection whose webhook key hashes to `hash` (JAK-189) — the
   * inbound auth lookup for POST /ghl/contact-created. Unique index → at most one.
   */
  async findByWebhookKeyHash(hash: string): Promise<GhlConnectionRow | null> {
    const result = await this.db.query<GhlConnectionRow>(
      `SELECT * FROM ghl_connections WHERE webhook_key_hash = $1`,
      [hash]
    );
    return result.rows[0] ?? null;
  }

  /** Rows still missing a webhook key (JAK-189 backfill target). */
  async listMissingWebhookKey(): Promise<GhlConnectionRow[]> {
    const result = await this.db.query<GhlConnectionRow>(
      `SELECT * FROM ghl_connections WHERE webhook_key_hash IS NULL`
    );
    return result.rows;
  }

  /** Resolve the connection whose associated phone numbers include `phoneNumber`. */
  async findByPhoneNumber(phoneNumber: string): Promise<GhlConnectionRow | null> {
    const result = await this.db.query<GhlConnectionRow>(
      `SELECT * FROM ghl_connections WHERE $1 = ANY(phone_numbers) LIMIT 1`,
      [phoneNumber]
    );
    return result.rows[0] ?? null;
  }

  async listAll(): Promise<GhlConnectionRow[]> {
    const result = await this.db.query<GhlConnectionRow>(
      `SELECT * FROM ghl_connections ORDER BY created_at DESC`
    );
    return result.rows;
  }

  /**
   * Patch a connection by location id. Only provided columns change; `updated_at`
   * is always bumped. Returns the updated row, or null if no such location.
   */
  async update(
    locationId: string,
    patch: UpdateGhlConnectionRow
  ): Promise<GhlConnectionRow | null> {
    const sets: string[] = [];
    const values: unknown[] = [];
    let i = 1;

    if (patch.name !== undefined) {
      sets.push(`name = $${i++}`);
      values.push(patch.name);
    }
    if (patch.api_key_encrypted !== undefined) {
      sets.push(`api_key_encrypted = $${i++}`);
      values.push(patch.api_key_encrypted);
    }
    if (patch.base_url !== undefined) {
      sets.push(`base_url = $${i++}`);
      values.push(patch.base_url);
    }
    if (patch.phone_numbers !== undefined) {
      sets.push(`phone_numbers = $${i++}`);
      values.push(patch.phone_numbers);
    }
    if (patch.status !== undefined) {
      sets.push(`status = $${i++}`);
      values.push(patch.status);
    }
    if (patch.text_mode !== undefined) {
      sets.push(`text_mode = $${i++}`);
      values.push(patch.text_mode);
    }
    if (patch.auto_enrichment_enabled !== undefined) {
      sets.push(`auto_enrichment_enabled = $${i++}`);
      values.push(patch.auto_enrichment_enabled);
    }
    if (patch.unlimited_credits !== undefined) {
      sets.push(`unlimited_credits = $${i++}`);
      values.push(patch.unlimited_credits);
    }
    if (patch.webhook_key_hash !== undefined) {
      sets.push(`webhook_key_hash = $${i++}`);
      values.push(patch.webhook_key_hash);
    }
    if (patch.webhook_key_enc !== undefined) {
      sets.push(`webhook_key_enc = $${i++}`);
      values.push(patch.webhook_key_enc);
    }

    // Nothing to change → return the current row unchanged.
    if (sets.length === 0) {
      return this.findByLocationId(locationId);
    }

    sets.push(`updated_at = now()`);
    values.push(locationId);

    const result = await this.db.query<GhlConnectionRow>(
      `UPDATE ghl_connections SET ${sets.join(", ")}
       WHERE location_id = $${i}
       RETURNING *`,
      values
    );
    return result.rows[0] ?? null;
  }

  /** Delete a connection by location id. Returns true if a row was removed. */
  async delete(locationId: string): Promise<boolean> {
    const result = await this.db.query(
      `DELETE FROM ghl_connections WHERE location_id = $1`,
      [locationId]
    );
    return (result.rowCount ?? 0) > 0;
  }
}
