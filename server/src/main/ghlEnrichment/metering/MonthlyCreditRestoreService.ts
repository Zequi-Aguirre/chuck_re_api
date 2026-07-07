import { injectable } from "tsyringe";
import { TextJakeCustomerStore } from "../customers/TextJakeCustomerStore";
import { CreditService } from "./CreditService";

/** What one sweep did (JAK-monthly-credit-restore) — for logging + tests. */
export interface MonthlyRestoreSummary {
  /** How many customers were restored to the effective default this run. */
  restored: number;
  /** Their credit-account ids (= customer ids), in the order they were restored. */
  accountIds: string[];
}

/**
 * The monthly credit RESTORE sweep (JAK-monthly-credit-restore).
 *
 * Once a month, on the anniversary of their signup, a customer's three credit
 * buckets are set BACK to the effective admin-editable default (report /
 * skiptrace / comps). RESTORE = set-to-default: no rollover, no accumulation —
 * exactly what a brand-new customer is seeded with, and exactly what the
 * JAK-reset-credits-button admin action gives, via the SAME
 * {@link CreditService.resetToDefaults} path (so a later default retune is
 * honored and the ledger keeps a full audit trail).
 *
 * The per-customer clock (`text_jake_customers.next_reset_at`) lives in the DB;
 * this service just drains everyone who is due. Each customer is claimed with an
 * atomic UPDATE that advances their `next_reset_at` past `asOf` in the same
 * statement ({@link TextJakeCustomerStore.claimDueForReset}), so:
 *   - the sweep is IDEMPOTENT — running it twice (or every hour) restores each
 *     due customer at most once per monthly cycle;
 *   - a long-down worker advances in one hop to the next future boundary, so it
 *     never multi-restores for the months it missed.
 *
 * The claim is the only guard needed; the reset itself is naturally set-to-target.
 * This service owns NO persistence and NO cost/ledger logic — it composes the
 * customer store's claim with the credit service's reset.
 */
@injectable()
export class MonthlyCreditRestoreService {
  /**
   * A safety bound on one sweep so a bug that failed to advance `next_reset_at`
   * can never spin forever. Far above any realistic number of customers due in a
   * single monthly cycle; hitting it is logged as an anomaly, not silently eaten.
   */
  private static readonly MAX_PER_SWEEP = 100_000;

  constructor(
    private readonly customers: TextJakeCustomerStore,
    private readonly credits: CreditService
  ) {}

  /**
   * Restore every customer whose `next_reset_at` is due as of `asOf` (defaults to
   * now). Claims one due customer at a time — the claim advances their clock, so
   * the loop naturally terminates when none remain due for this `asOf`. Each
   * claimed customer's three buckets are reset to the effective default; the
   * claim already moved their next restore a month out.
   */
  async restoreDue(asOf: Date = this.clock()): Promise<MonthlyRestoreSummary> {
    const accountIds: string[] = [];
    for (let i = 0; i < MonthlyCreditRestoreService.MAX_PER_SWEEP; i++) {
      const claimed = await this.customers.claimDueForReset(asOf);
      if (!claimed) {
        return { restored: accountIds.length, accountIds };
      }
      // The credit-account key IS the customer id (JAK-115). resetToDefaults sets
      // each bucket to its effective admin-editable default via grant/charge of
      // the delta, writing the ledger audit trail (a bucket already at default is
      // a no-op).
      await this.credits.resetToDefaults(claimed.id);
      accountIds.push(claimed.id);
    }
    console.warn(
      `⚠️ MonthlyCreditRestore hit the ${MonthlyCreditRestoreService.MAX_PER_SWEEP} ` +
        `per-sweep cap — more customers may still be due; the next run will pick them up.`
    );
    return { restored: accountIds.length, accountIds };
  }

  /** Time source — a tiny indirection so tests can drive the sweep deterministically. */
  protected clock(): Date {
    return new Date();
  }
}
