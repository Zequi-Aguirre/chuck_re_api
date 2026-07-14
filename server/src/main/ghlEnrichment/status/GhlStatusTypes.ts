import { EnrichmentEventStatus } from "../worker/GhlEnrichmentEventStore";
import { GhlConnectionStatus } from "../connections/GhlConnectionTypes";

/**
 * Read-only status view DTOs (JAK-112).
 *
 * These are the SAFE projections the status API returns. They are built by
 * {@link import("./GhlStatusService").GhlStatusService} by aggregating the
 * existing JAK-102/105/107/109/111 stores — they intentionally OMIT every
 * credential-bearing column (`api_key_encrypted`, base URLs are kept as they are
 * not secret, but the encrypted key and any token are never mapped). Nothing here
 * can carry a decrypted key or Bearer token; the service maps field-by-field so
 * a new secret column can never leak into a response by accident.
 */

/** Per-location connection health — safe subset of `ghl_connections`. */
export interface ConnectionStatusView {
  locationId: string;
  /** JAK-190 — friendly admin label; null → the UI shows the location id. */
  name: string | null;
  /** active | inactive. Inactive = uninstalled; the worker no longer processes it. */
  status: GhlConnectionStatus;
  baseUrl: string;
  /** How many phone numbers route to this location (text-Jake, JAK-114). Count only. */
  phoneNumberCount: number;
  /** Provisioned (non-deleted) Jake custom fields — the write-back targets (JAK-105). */
  provisionedFieldCount: number;
  /** JAK-186 — per-location contact-created auto-enrichment toggle (opt-in). */
  autoEnrichmentEnabled: boolean;
  /** JAK-191 — unlimited-credits flag; the UI shows "Unlimited" instead of a number. */
  unlimitedCredits: boolean;
  installedAt: Date;
  updatedAt: Date;
}

/** Enrichment outcome tallies for a location — every status, zero-filled. */
export interface EnrichmentOutcomeCounts {
  enriched: number;
  skipped: number;
  credit_blocked: number;
  failed: number;
  dead_letter: number;
  /** Sum of the above — total contacts the worker has recorded for this location. */
  total: number;
}

/** One credit ledger entry — safe projection of `credit_ledger` (JAK-109). */
export interface LedgerEntryView {
  id: string;
  /** Signed: negative = charge, positive = grant/refund. */
  amount: number;
  balanceAfter: number;
  reason: string;
  contactId: string | null;
  createdAt: Date;
}

/** One enrichment event — safe projection of `ghl_enrichment_events`. */
export interface EnrichmentEventView {
  contactId: string;
  status: EnrichmentEventStatus;
  /** Short, secret-free reason/summary (JAK-111 `detail`). Never a credential. */
  detail: string | null;
  attemptCount: number;
  enrichedAt: Date | null;
  failedAt: Date | null;
  updatedAt: Date;
}

/** A location row in the overview list — connection + balance + outcome counts. */
export interface LocationStatusSummary {
  connection: ConnectionStatusView;
  creditBalance: number;
  outcomes: EnrichmentOutcomeCounts;
}

/** Full per-location health — the detail endpoint's payload. */
export interface LocationStatusDetail {
  connection: ConnectionStatusView;
  credits: {
    balance: number;
    recent: LedgerEntryView[];
  };
  enrichment: {
    counts: EnrichmentOutcomeCounts;
    recent: EnrichmentEventView[];
  };
  /**
   * The JAK-111 failed / dead-lettered records with their failure reason, parked
   * for inspection / requeue. Most-recently-touched first.
   */
  failures: EnrichmentEventView[];
}
