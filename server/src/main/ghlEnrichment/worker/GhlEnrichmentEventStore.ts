import { injectable } from "tsyringe";
import { PostgresDatabase } from "../../data/PostgresDatabase";

/**
 * The outcome of processing one contact. Mirrors the `status` column on
 * `ghl_enrichment_events` (JAK-107 migration):
 *   - `enriched` — write-back succeeded (or ran; off-prod writes are echoed).
 *   - `skipped`  — a permanent, non-error outcome (inactive location, contact
 *     gone, no usable address, no property match). Not worth retrying.
 *   - `failed`   — an error occurred; `detail` carries a short, secret-free note.
 *   - `credit_blocked` — the location had insufficient credits (JAK-109), so no
 *     paid work ran. Not an error; reprocesses cleanly once credits are granted.
 */
export type EnrichmentEventStatus =
  | "enriched"
  | "skipped"
  | "failed"
  | "credit_blocked";

/** Raw persistence row for the `ghl_enrichment_events` table (JAK-107). */
export interface GhlEnrichmentEventRow {
  id: string;
  location_id: string;
  contact_id: string;
  status: EnrichmentEventStatus;
  detail: string | null;
  cost_estimate: number | null;
  enriched_at: Date | null;
  created_at: Date;
  modified_at: Date;
}

/** What the worker records after processing a contact. */
export interface RecordEnrichmentEventInput {
  location_id: string;
  contact_id: string;
  status: EnrichmentEventStatus;
  /** Short, SECRET-FREE reason/summary — never a credential. */
  detail?: string | null;
  cost_estimate?: number | null;
}

/**
 * Data-access layer for per-contact enrichment events (JAK-107).
 *
 * Pure SQL over {@link PostgresDatabase}, mirroring the JAK-102/JAK-105 stores:
 * same snake_case columns, timestamptz timestamps, and lazy pool. It backs both
 * the worker's idempotency check ({@link findByContact}) and the metering log
 * ({@link record} upserts one row per contact).
 */
@injectable()
export class GhlEnrichmentEventStore {
  constructor(private readonly db: PostgresDatabase) {}

  /** The recorded event for a contact, or null if it's never been processed. */
  async findByContact(
    locationId: string,
    contactId: string
  ): Promise<GhlEnrichmentEventRow | null> {
    const result = await this.db.query<GhlEnrichmentEventRow>(
      `SELECT * FROM ghl_enrichment_events
       WHERE location_id = $1 AND contact_id = $2`,
      [locationId, contactId]
    );
    return result.rows[0] ?? null;
  }

  /**
   * Record the outcome of processing a contact, UPSERTing on
   * (location_id, contact_id). A first attempt that fails records `failed`; a
   * later successful reprocess flips the same row to `enriched`. `enriched_at`
   * is stamped only on the `enriched` status (and cleared otherwise), so the
   * metering log can tell a real enrichment from a skip/failure.
   */
  async record(input: RecordEnrichmentEventInput): Promise<GhlEnrichmentEventRow> {
    const enrichedAt = input.status === "enriched" ? "now()" : "null";
    const result = await this.db.query<GhlEnrichmentEventRow>(
      `INSERT INTO ghl_enrichment_events
         (location_id, contact_id, status, detail, cost_estimate, enriched_at)
       VALUES ($1, $2, $3, $4, $5, ${enrichedAt})
       ON CONFLICT (location_id, contact_id) DO UPDATE SET
         status        = excluded.status,
         detail        = excluded.detail,
         cost_estimate = excluded.cost_estimate,
         enriched_at   = ${enrichedAt},
         modified_at   = now()
       RETURNING *`,
      [
        input.location_id,
        input.contact_id,
        input.status,
        input.detail ?? null,
        input.cost_estimate ?? null,
      ]
    );
    return result.rows[0];
  }
}
