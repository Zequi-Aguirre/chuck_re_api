import { injectable } from "tsyringe";
import { AppSettingsStore } from "../../data/AppSettingsStore";
import { parsePositiveInt } from "../../ghlEnrichment/conversation/ConversationSettingsService";
import {
  CompParams,
  DEFAULT_COMP_PARAMS,
  clampCompParams,
  parseStoredCompParams,
} from "./CompsTypes";

/** The admin-facing view of the editable comps credit cost (JAK-137). */
export interface CompsCostView {
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
 * JAK-164 — the CANDIDATE-POOL parameters the selection engine fetches with:
 * the geo-radius (miles) it searches /v2/PropertySearch within, the sold-recency
 * window (days), and the max candidate count it pulls before selecting. These are
 * the "API Search Intent" knobs (spec: radius up to 10 mi, 365 days back) — distinct
 * from the texter-facing bed/bath/sqft tolerances. Settings-backed so they are
 * tunable without a redeploy, with code defaults as the single source of truth.
 */
export interface CompsPoolParams {
  radiusMiles: number;
  maxDaysBack: number;
  maxCandidates: number;
}

/** The admin-facing view of the editable DEFAULT comp parameters (JAK-137). */
export interface CompsParamsView {
  /** The effective default parameters — the stored value, or the code default. */
  params: CompParams;
  /** True when no admin has customized them (i.e. the code defaults are in force). */
  isDefault: boolean;
  /** When they were last edited; null while they are the untouched default. */
  updatedAt: Date | null;
  /** The admin id that last edited them; null while they are the untouched default. */
  updatedBy: string | null;
}

/**
 * Owns the admin-configurable CREDIT COST of one text-Jake comps pull AND the
 * admin-configurable DEFAULT comp PARAMETERS (JAK-137), using the SAME editable
 * pattern as the JAK-136 skip-trace settings and JAK-134 conversation settings:
 * both values live in the `app_settings` KV store so an admin can retune the
 * economics + the default search without a redeploy, with code defaults as the
 * single source of truth for the fallbacks.
 *
 * A comps pull costs MORE than a report (it hits the paid /v2/PropertyDetail
 * endpoint with comps:true), so cost is its own knob — default 3 credits. The default parameters
 * (radius, count, timeframe, bed/bath/sqft tolerance) are what the specialist uses
 * when the texter doesn't specify their own; a texter's in-message overrides still
 * win, and every value is clamped to sane bounds regardless. Short-TTL caches keep
 * the hot text path off Postgres; an edit busts them immediately. A stored cost
 * that isn't a positive integer is ignored in favor of the default, so a bad admin
 * entry can never zero out (make free) a paid comps pull.
 */
@injectable()
export class CompsSettingsService {
  /** The app_settings key backing the editable comps credit cost. */
  static readonly CREDIT_COST_KEY = "credit_cost_comps";
  /** The app_settings key backing the editable default comp parameters (JSON). */
  static readonly PARAMS_KEY = "comps_params";
  /** JAK-164: the app_settings key backing the selection candidate-pool parameters (JSON). */
  static readonly POOL_KEY = "comps_pool";

  /** Code default — MIRRORS the seed in the seed_comps_settings migration. */
  static readonly DEFAULT_CREDIT_COST = 3;
  /** Code default parameters — MIRRORS the seed + {@link DEFAULT_COMP_PARAMS}. */
  static readonly DEFAULT_PARAMS: CompParams = DEFAULT_COMP_PARAMS;
  /** JAK-164 code default pool — MIRRORS the seed_comps_selection_prompt migration. */
  static readonly DEFAULT_POOL: CompsPoolParams = {
    radiusMiles: 10,
    maxDaysBack: 365,
    maxCandidates: 50,
  };

  private static readonly CACHE_TTL_MS = 30_000;

  private costCache?: { value: number; at: number };
  private paramsCache?: { value: CompParams; at: number };
  private poolCache?: { value: CompsPoolParams; at: number };

  constructor(private readonly settings: AppSettingsStore) {}

  // ── Credit cost ────────────────────────────────────────────────────────────

  /** The effective comps cost in credits (default 3). Cached for the TTL. */
  async costOfComps(): Promise<number> {
    const now = this.clock();
    if (this.costCache && now - this.costCache.at < CompsSettingsService.CACHE_TTL_MS) {
      return this.costCache.value;
    }
    const row = await this.settings.get(CompsSettingsService.CREDIT_COST_KEY);
    const value = parsePositiveInt(row?.value) ?? CompsSettingsService.DEFAULT_CREDIT_COST;
    this.costCache = { value, at: now };
    return value;
  }

  /** The admin view: the effective cost plus edit metadata. */
  async getCostView(): Promise<CompsCostView> {
    const row = await this.settings.get(CompsSettingsService.CREDIT_COST_KEY);
    const stored = parsePositiveInt(row?.value);
    return {
      value: stored ?? CompsSettingsService.DEFAULT_CREDIT_COST,
      isDefault: stored === null,
      updatedAt: stored !== null ? row!.updated_at : null,
      updatedBy: stored !== null ? row!.updated_by : null,
    };
  }

  /** Save an admin-edited cost (positive integer); busts the cache immediately. */
  async setCost(value: number, adminId: string | null): Promise<CompsCostView> {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`${CompsSettingsService.CREDIT_COST_KEY} must be a positive integer`);
    }
    const row = await this.settings.set(CompsSettingsService.CREDIT_COST_KEY, String(value), adminId);
    this.costCache = { value, at: this.clock() };
    return { value, isDefault: false, updatedAt: row.updated_at, updatedBy: row.updated_by };
  }

  /** Revert the cost to the code default by clearing the stored value; busts the cache. */
  async resetCost(): Promise<CompsCostView> {
    await this.settings.delete(CompsSettingsService.CREDIT_COST_KEY);
    this.costCache = undefined;
    return {
      value: CompsSettingsService.DEFAULT_CREDIT_COST,
      isDefault: true,
      updatedAt: null,
      updatedBy: null,
    };
  }

  // ── Default parameters ───────────────────────────────────────────────────────

  /**
   * The effective DEFAULT comp parameters: the admin-edited set if a valid one is
   * stored, otherwise the code defaults. Always clamped. Cached for the TTL. This
   * is what the specialist starts from before applying a texter's overrides.
   */
  async defaultParams(): Promise<CompParams> {
    const now = this.clock();
    if (this.paramsCache && now - this.paramsCache.at < CompsSettingsService.CACHE_TTL_MS) {
      return this.paramsCache.value;
    }
    const row = await this.settings.get(CompsSettingsService.PARAMS_KEY);
    const value = parseStoredCompParams(row?.value) ?? CompsSettingsService.DEFAULT_PARAMS;
    this.paramsCache = { value, at: now };
    return value;
  }

  /** The admin view: the effective default parameters plus edit metadata. */
  async getParamsView(): Promise<CompsParamsView> {
    const row = await this.settings.get(CompsSettingsService.PARAMS_KEY);
    const stored = parseStoredCompParams(row?.value);
    return {
      params: stored ?? CompsSettingsService.DEFAULT_PARAMS,
      isDefault: stored === null,
      updatedAt: stored !== null ? row!.updated_at : null,
      updatedBy: stored !== null ? row!.updated_by : null,
    };
  }

  /**
   * Save an admin-edited default parameter-set; clamps to sane bounds first, then
   * persists the clamped values as JSON and busts the cache immediately.
   */
  async setParams(params: CompParams, adminId: string | null): Promise<CompsParamsView> {
    const clamped = clampCompParams(params);
    const row = await this.settings.set(
      CompsSettingsService.PARAMS_KEY,
      JSON.stringify(clamped),
      adminId
    );
    this.paramsCache = { value: clamped, at: this.clock() };
    return { params: clamped, isDefault: false, updatedAt: row.updated_at, updatedBy: row.updated_by };
  }

  /** Revert the default parameters to the code default; busts the cache. */
  async resetParams(): Promise<CompsParamsView> {
    await this.settings.delete(CompsSettingsService.PARAMS_KEY);
    this.paramsCache = undefined;
    return {
      params: CompsSettingsService.DEFAULT_PARAMS,
      isDefault: true,
      updatedAt: null,
      updatedBy: null,
    };
  }

  // ── Selection candidate-pool parameters (JAK-164) ──────────────────────────

  /**
   * The effective CANDIDATE-POOL parameters for the selection engine: the stored
   * set if valid, else the code default. Every value is clamped to sane bounds
   * (radius 1-10 mi, window 30-365 days, candidates 10-250) so a bad stored value
   * can never blow up the pool fetch. Cached for the TTL.
   */
  async poolParams(): Promise<CompsPoolParams> {
    const now = this.clock();
    if (this.poolCache && now - this.poolCache.at < CompsSettingsService.CACHE_TTL_MS) {
      return this.poolCache.value;
    }
    const row = await this.settings.get(CompsSettingsService.POOL_KEY);
    const value = CompsSettingsService.parsePool(row?.value);
    this.poolCache = { value, at: now };
    return value;
  }

  /** Parse + clamp a stored pool JSON, filling any missing field from the code default. */
  private static parsePool(raw: string | null | undefined): CompsPoolParams {
    const d = CompsSettingsService.DEFAULT_POOL;
    let obj: Record<string, unknown> = {};
    if (raw && raw.trim()) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") obj = parsed as Record<string, unknown>;
      } catch {
        obj = {};
      }
    }
    const pick = (key: keyof CompsPoolParams, min: number, max: number): number => {
      const v = obj[key];
      const n = typeof v === "number" && Number.isFinite(v) ? v : d[key];
      return Math.round(Math.min(max, Math.max(min, n)));
    };
    return {
      radiusMiles: pick("radiusMiles", 1, 10),
      maxDaysBack: pick("maxDaysBack", 30, 365),
      maxCandidates: pick("maxCandidates", 10, 250),
    };
  }

  /** Time source — a tiny indirection so tests can drive the TTL deterministically. */
  protected clock(): number {
    return Date.now();
  }
}
