import { injectable } from "tsyringe";
import { GhlConnectionRow, GhlConnectionStore } from "../connections/GhlConnectionStore";
import { GhlCustomFieldStore } from "../lifecycle/GhlCustomFieldStore";
import { CreditLedgerRow, CreditLedgerStore } from "../metering/CreditLedgerStore";
import {
  EnrichmentEventStatus,
  GhlEnrichmentEventRow,
  GhlEnrichmentEventStore,
} from "../worker/GhlEnrichmentEventStore";
import {
  ConnectionStatusView,
  EnrichmentEventView,
  EnrichmentOutcomeCounts,
  LedgerEntryView,
  LocationStatusDetail,
  LocationStatusSummary,
} from "./GhlStatusTypes";

/** Every enrichment status, so the fold below always emits a zero-filled tally. */
const ALL_STATUSES: EnrichmentEventStatus[] = [
  "enriched",
  "skipped",
  "credit_blocked",
  "failed",
  "dead_letter",
];

/** The failure statuses the status view surfaces for inspection / requeue (JAK-111). */
const FAILURE_STATUSES: EnrichmentEventStatus[] = ["failed", "dead_letter"];

/**
 * Read-only status aggregation for the enrichment app (JAK-112).
 *
 * The single place that assembles "what's happening for this location" by
 * WRAPPING the existing stores — it adds no persistence and duplicates no query
 * logic already owned by JAK-102/105/107/109/111; it only fans out to their
 * methods and folds the results into the safe {@link GhlStatusTypes} DTOs.
 *
 * SECURITY: it reads the connection store's RAW row but maps it field-by-field
 * into {@link ConnectionStatusView}, deliberately never touching
 * `api_key_encrypted` and never invoking the {@link
 * import("../connections/GhlConnectionService").GhlConnectionService} decrypt
 * path — so no decrypted key or Bearer token can reach a response.
 *
 * Efficiency: the overview list uses one grouped query per dimension
 * (counts / balances / field-counts) rather than an N+1 per installed location,
 * and every read is served by the indexes JAK-107/109/111 already created.
 */
@injectable()
export class GhlStatusService {
  constructor(
    private readonly connections: GhlConnectionStore,
    private readonly customFields: GhlCustomFieldStore,
    private readonly events: GhlEnrichmentEventStore,
    private readonly ledger: CreditLedgerStore
  ) {}

  /**
   * Overview of every installed location: connection health + credit balance +
   * enrichment outcome counts. Four grouped scans total, folded in memory — no
   * per-location query. Ordered by the connection store (newest install first).
   */
  async listLocationStatuses(): Promise<LocationStatusSummary[]> {
    const [rows, fieldCounts, balances, statusCounts] = await Promise.all([
      this.connections.listAll(),
      this.customFields.countByLocationForAll(),
      this.ledger.listBalances(),
      this.events.countByStatusForAllLocations(),
    ]);

    const fieldCountByLocation = new Map(fieldCounts.map((f) => [f.location_id, f.count]));
    const balanceByLocation = new Map(balances.map((b) => [b.location_id, b.balance]));

    // Fold the flat (location, status, count) rows into a per-location tally.
    const countsByLocation = new Map<string, EnrichmentOutcomeCounts>();
    for (const row of statusCounts) {
      const tally = countsByLocation.get(row.location_id) ?? emptyCounts();
      applyCount(tally, row.status, row.count);
      countsByLocation.set(row.location_id, tally);
    }

    return rows.map((row) => ({
      connection: this.toConnectionView(row, fieldCountByLocation.get(row.location_id) ?? 0),
      creditBalance: balanceByLocation.get(row.location_id) ?? 0,
      outcomes: countsByLocation.get(row.location_id) ?? emptyCounts(),
    }));
  }

  /**
   * Full health for one location, or null if it was never installed. Fans out to
   * the connection / field / credit / event stores in parallel and maps each to
   * a safe view. `recentLimit` bounds the recent-activity lists.
   */
  async getLocationStatus(
    locationId: string,
    recentLimit = 20
  ): Promise<LocationStatusDetail | null> {
    const connection = await this.connections.findByLocationId(locationId);
    if (!connection) return null;

    const [fields, balance, recentLedger, statusCounts, recentEvents, failures] =
      await Promise.all([
        this.customFields.listByLocation(locationId),
        this.ledger.getBalance(locationId),
        this.ledger.recentEntries(locationId, recentLimit),
        this.events.countByStatus(locationId),
        this.events.listByStatus(locationId, ALL_STATUSES, recentLimit),
        this.events.listByStatus(locationId, FAILURE_STATUSES, recentLimit),
      ]);

    const counts = emptyCounts();
    for (const c of statusCounts) applyCount(counts, c.status, c.count);

    return {
      connection: this.toConnectionView(connection, fields.length),
      credits: {
        balance,
        recent: recentLedger.map(toLedgerView),
      },
      enrichment: {
        counts,
        recent: recentEvents.map(toEventView),
      },
      failures: failures.map(toEventView),
    };
  }

  /**
   * Map a raw connection row to the safe view. Field-by-field ON PURPOSE — never
   * spreads the row, so `api_key_encrypted` (and any future secret column) can
   * never leak into a response.
   */
  private toConnectionView(row: GhlConnectionRow, provisionedFieldCount: number): ConnectionStatusView {
    return {
      locationId: row.location_id,
      status: row.status,
      baseUrl: row.base_url,
      phoneNumberCount: row.phone_numbers?.length ?? 0,
      provisionedFieldCount,
      installedAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

/** A zero-filled outcome tally so a location with no events still reports cleanly. */
function emptyCounts(): EnrichmentOutcomeCounts {
  return { enriched: 0, skipped: 0, credit_blocked: 0, failed: 0, dead_letter: 0, total: 0 };
}

/** Add one status's count into a tally and keep `total` in sync. */
function applyCount(tally: EnrichmentOutcomeCounts, status: EnrichmentEventStatus, count: number): void {
  tally[status] += count;
  tally.total += count;
}

function toLedgerView(row: CreditLedgerRow): LedgerEntryView {
  return {
    id: row.id,
    amount: row.amount,
    balanceAfter: row.balance_after,
    reason: row.reason,
    contactId: row.contact_id,
    createdAt: row.created_at,
  };
}

function toEventView(row: GhlEnrichmentEventRow): EnrichmentEventView {
  return {
    contactId: row.contact_id,
    status: row.status,
    detail: row.detail,
    attemptCount: row.attempt_count,
    enrichedAt: row.enriched_at,
    failedAt: row.failed_at,
    updatedAt: row.modified_at,
  };
}
