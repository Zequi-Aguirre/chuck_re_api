import { injectable } from "tsyringe";
import { AppSettingsStore } from "../../data/AppSettingsStore";
import { parsePositiveInt } from "../../ghlEnrichment/conversation/ConversationSettingsService";

/** The admin-facing view of the editable skip-trace credit cost (JAK-136). */
export interface SkipTraceCostView {
  /** The effective cost in credits — the stored value, or the code default. */
  value: number;
  /** True when no admin has customized it (i.e. `value` is the code default). */
  isDefault: boolean;
  /** When it was last edited; null while it is the untouched default. */
  updatedAt: Date | null;
  /** The admin id that last edited it; null while it is the untouched default. */
  updatedBy: string | null;
}

/**
 * Owns the admin-configurable CREDIT COST of one text-Jake skip trace (JAK-136),
 * using the SAME editable pattern as the JAK-134 conversation settings and the
 * JAK-131 report prompt: the value lives in the `app_settings` KV store so an
 * admin can retune the economics without a redeploy, with a code default as the
 * single source of truth for the fallback.
 *
 * Skip trace costs MORE than a report (it hits the paid /v2/SkipTrace endpoint),
 * so this is its own knob — default 3 credits — distinct from the enrichment
 * skip-trace cost and the JAK-115 text-lookup cost. A short-TTL cache keeps the
 * hot text path off Postgres; an edit busts it immediately. A stored value that
 * isn't a positive integer is ignored in favor of the default, so a bad admin
 * entry can never zero out (make free) a paid trace.
 */
@injectable()
export class SkipTraceSettingsService {
  /** The single app_settings key backing the editable skip-trace credit cost. */
  static readonly CREDIT_COST_KEY = "credit_cost_skiptrace";

  /** Code default — MIRRORS the seed in the seed_skiptrace_settings migration. */
  static readonly DEFAULT_CREDIT_COST = 3;

  private static readonly CACHE_TTL_MS = 30_000;

  private cache?: { value: number; at: number };

  constructor(private readonly settings: AppSettingsStore) {}

  /** The effective skip-trace cost in credits (default 3). Cached for the TTL. */
  async costOfSkipTrace(): Promise<number> {
    const now = this.clock();
    if (this.cache && now - this.cache.at < SkipTraceSettingsService.CACHE_TTL_MS) {
      return this.cache.value;
    }
    const row = await this.settings.get(SkipTraceSettingsService.CREDIT_COST_KEY);
    const value = parsePositiveInt(row?.value) ?? SkipTraceSettingsService.DEFAULT_CREDIT_COST;
    this.cache = { value, at: now };
    return value;
  }

  /** The admin view: the effective cost plus edit metadata. */
  async getView(): Promise<SkipTraceCostView> {
    const row = await this.settings.get(SkipTraceSettingsService.CREDIT_COST_KEY);
    const stored = parsePositiveInt(row?.value);
    return {
      value: stored ?? SkipTraceSettingsService.DEFAULT_CREDIT_COST,
      isDefault: stored === null,
      updatedAt: stored !== null ? row!.updated_at : null,
      updatedBy: stored !== null ? row!.updated_by : null,
    };
  }

  /** Save an admin-edited cost (positive integer); busts the cache immediately. */
  async setCost(value: number, adminId: string | null): Promise<SkipTraceCostView> {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`${SkipTraceSettingsService.CREDIT_COST_KEY} must be a positive integer`);
    }
    const row = await this.settings.set(
      SkipTraceSettingsService.CREDIT_COST_KEY,
      String(value),
      adminId
    );
    this.cache = { value, at: this.clock() };
    return { value, isDefault: false, updatedAt: row.updated_at, updatedBy: row.updated_by };
  }

  /** Revert to the code default by clearing the stored value; busts the cache. */
  async resetCost(): Promise<SkipTraceCostView> {
    await this.settings.delete(SkipTraceSettingsService.CREDIT_COST_KEY);
    this.cache = undefined;
    return {
      value: SkipTraceSettingsService.DEFAULT_CREDIT_COST,
      isDefault: true,
      updatedAt: null,
      updatedBy: null,
    };
  }

  /** Time source — a tiny indirection so tests can drive the TTL deterministically. */
  protected clock(): number {
    return Date.now();
  }
}
