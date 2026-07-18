/**
 * GHL auto-enrichment job payload types (JAK-181, epic JAK-180).
 *
 * The typed contract for a single auto-enrichment job:
 *
 *   (JAK-182) contact-created webhook  ──submit──▶  [ InProcessEnrichmentRunner ]
 *     builds AutoEnrichmentJobPayload      ──▶  (JAK-183) worker: JAK-184 format + write-back
 *
 * One payload = one GHL contact to enrich. It carries the tenant (`locationId`)
 * and the contact (`contactId`, also the runner's dedupe key) plus EITHER a parsed
 * `address` OR the `rawContact` body the producer received — whichever JAK-182 has
 * on hand. This module owns ONLY the shape.
 *
 * JAK-197: enrichment runs IN-PROCESS (no BullMQ/Redis); the payload shape is
 * unchanged — only the transport moved from a queue to the in-process runner.
 */

/**
 * A parsed subject address for the REAPI PropertyDetail lookup. All parts are
 * optional so a producer can enqueue whatever it resolved; JAK-183 decides what's
 * sufficient for a lookup.
 */
export interface AutoEnrichmentAddress {
  /** Street line, e.g. "123 Main St". */
  line1?: string;
  city?: string;
  /** Two-letter state / region code, e.g. "TX". */
  state?: string;
  /** ZIP / postal code. */
  postal?: string;
}

/**
 * One enrichment job. `locationId` + `contactId` are always required (the tenant
 * and the contact to write back to); `contactId` is also the BullMQ `jobId`, so a
 * re-fired contact de-dupes against an already queued/active job.
 *
 * A producer supplies EITHER `address` (already parsed) OR `rawContact` (the
 * upstream GHL contact body, parsed later by JAK-183) — at least one should be
 * present, but the type keeps both optional so a producer can pass what it has.
 */
export interface AutoEnrichmentJobPayload {
  /** GHL sub-account (tenant) id — selects the per-location credentials. */
  locationId: string;
  /** GHL contact id — write-back target AND the queue dedupe key. */
  contactId: string;
  /** Parsed property address, when the producer already resolved it. */
  address?: AutoEnrichmentAddress;
  /** Raw upstream GHL contact payload, when the address isn't pre-parsed. */
  rawContact?: Record<string, unknown>;
}
