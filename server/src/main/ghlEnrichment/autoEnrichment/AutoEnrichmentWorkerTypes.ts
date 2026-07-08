/**
 * Outcome types for the auto-enrichment worker (JAK-183, epic JAK-180).
 *
 * The worker's {@link import("./AutoEnrichmentWorker").AutoEnrichmentWorker.process}
 * returns one of these to describe how a job resolved — logged by the BullMQ
 * worker and asserted in tests. A THROWN error (not an outcome) is the retry
 * signal: a transient REAPI/GHL 429/5xx propagates so BullMQ retries; everything
 * else finishes cleanly with one of these terminal outcomes.
 */

/**
 * How one enrichment job resolved (a NON-error, terminal result):
 *  - `enriched`  — REAPI matched, fields written back to GHL.
 *  - `not_found` — REAPI returned a valid no-match; nothing written (not retried).
 *  - `no_address`— the job carried no resolvable property address; nothing looked
 *                  up or written (not retried — retrying can't add an address).
 */
export type AutoEnrichmentOutcomeStatus = "enriched" | "not_found" | "no_address";

/** The terminal result of processing one job. */
export interface AutoEnrichmentOutcome {
  status: AutoEnrichmentOutcomeStatus;
  locationId: string;
  contactId: string;
  /** Number of GHL fields written (present only when `status === "enriched"`). */
  written?: number;
  /** Number of formatter fields skipped for want of a GHL target field. */
  skipped?: number;
}
