import { injectable } from "tsyringe";
import { PostgresDatabase } from "../../data/PostgresDatabase";

/**
 * The outcome of processing one contact. Mirrors the `status` column on
 * `ghl_enrichment_events` (JAK-107 + JAK-111 migrations):
 *   - `enriched` — write-back succeeded (or ran; off-prod writes are echoed).
 *   - `skipped`  — a permanent, non-error outcome (inactive location, contact
 *     gone, no usable address, no property match). Not worth retrying.
 *   - `failed`   — an attempt errored and BullMQ will RETRY it; `detail` carries
 *     a short, secret-free note. Transitional, not terminal.
 *   - `dead_letter` — retries are exhausted, or the failure was permanent: the
 *     record is parked for inspection / requeue (JAK-111). Terminal.
 *   - `credit_blocked` — the location had insufficient credits (JAK-109), so no
 *     paid work ran. Not an error; reprocesses cleanly once credits are granted.
 */
export type EnrichmentEventStatus =
  | "enriched"
  | "skipped"
  | "failed"
  | "dead_letter"
  | "credit_blocked";

/** Raw persistence row for the `ghl_enrichment_events` table (JAK-107). */
export interface GhlEnrichmentEventRow {
  id: string;
  location_id: string;
  contact_id: string;
  status: EnrichmentEventStatus;
  detail: string | null;
  cost_estimate: number | null;
  attempt_count: number;
  enriched_at: Date | null;
  failed_at: Date | null;
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
  /** 1-based processing attempt this record reflects (JAK-111). */
  attempt_count?: number | null;
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
   * is stamped only on the `enriched` status; `failed_at` only on
   * `failed`/`dead_letter` (both cleared otherwise), so the metering + status
   * views can tell a real enrichment from a skip/failure and time-query each.
   */
  async record(input: RecordEnrichmentEventInput): Promise<GhlEnrichmentEventRow> {
    const enrichedAt = input.status === "enriched" ? "now()" : "null";
    const failedAt =
      input.status === "failed" || input.status === "dead_letter" ? "now()" : "null";
    const result = await this.db.query<GhlEnrichmentEventRow>(
      `INSERT INTO ghl_enrichment_events
         (location_id, contact_id, status, detail, cost_estimate, attempt_count,
          enriched_at, failed_at)
       VALUES ($1, $2, $3, $4, $5, $6, ${enrichedAt}, ${failedAt})
       ON CONFLICT (location_id, contact_id) DO UPDATE SET
         status        = excluded.status,
         detail        = excluded.detail,
         cost_estimate = excluded.cost_estimate,
         attempt_count = excluded.attempt_count,
         enriched_at   = ${enrichedAt},
         failed_at     = ${failedAt},
         modified_at   = now()
       RETURNING *`,
      [
        input.location_id,
        input.contact_id,
        input.status,
        input.detail ?? null,
        input.cost_estimate ?? null,
        input.attempt_count ?? 0,
      ]
    );
    return result.rows[0];
  }

  /**
   * Flip a record to the terminal `dead_letter` state (JAK-111) — retries are
   * exhausted or the failure was permanent. Idempotent: safe to call more than
   * once for the same terminal failure. It refuses to clobber an `enriched`
   * row (the `WHERE` guard), so a late duplicate can never bury a real success;
   * if the row is already enriched the UPDATE is skipped and this returns null.
   * If no row exists yet (the failing attempt never got to record one), one is
   * inserted so the failure is never silently lost.
   */
  async markDeadLetter(
    locationId: string,
    contactId: string,
    detail?: string | null
  ): Promise<GhlEnrichmentEventRow | null> {
    const result = await this.db.query<GhlEnrichmentEventRow>(
      `INSERT INTO ghl_enrichment_events
         (location_id, contact_id, status, detail, failed_at)
       VALUES ($1, $2, 'dead_letter', $3, now())
       ON CONFLICT (location_id, contact_id) DO UPDATE SET
         status      = 'dead_letter',
         detail      = excluded.detail,
         failed_at   = now(),
         modified_at = now()
       WHERE ghl_enrichment_events.status <> 'enriched'
       RETURNING *`,
      [locationId, contactId, detail ?? null]
    );
    return result.rows[0] ?? null;
  }

  /**
   * List a location's records in the given statuses, most-recently-touched
   * first. The queryable surface the status view (JAK-112) and any requeue
   * tooling read to SURFACE failures — e.g. `["failed", "dead_letter"]`.
   */
  async listByStatus(
    locationId: string,
    statuses: EnrichmentEventStatus[],
    limit = 50
  ): Promise<GhlEnrichmentEventRow[]> {
    const result = await this.db.query<GhlEnrichmentEventRow>(
      `SELECT * FROM ghl_enrichment_events
       WHERE location_id = $1 AND status = ANY($2)
       ORDER BY modified_at DESC
       LIMIT $3`,
      [locationId, statuses, limit]
    );
    return result.rows;
  }
}
