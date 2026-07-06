import { injectable } from "tsyringe";
import { AppSettingsStore } from "../../data/AppSettingsStore";

/** The admin-facing view of the editable comps SELECTION prompt (JAK-164). */
export interface CompsSelectionPromptView {
  /** The effective prompt — the stored value, or the code default. */
  prompt: string;
  /** True when no admin has customized it, i.e. `prompt` is the code default. */
  isDefault: boolean;
  /** When it was last edited; null while it is the untouched default. */
  updatedAt: Date | null;
  /** The admin id that last edited it; null while it is the untouched default. */
  updatedBy: string | null;
}

/**
 * Owns the editable SELECTION-ENGINE prompt for the text-Jake comps specialist
 * (JAK-164), using the SAME editable pattern as the JAK-137 comps STYLE prompt and
 * the JAK-131/135/136 prompts: the value lives in the `app_settings` KV store so an
 * admin can tune HOW Jake chooses the strongest comparable sales — the scoring,
 * reject, distance/recency, and outlier heuristics — without a redeploy, with the
 * code default as the single source of truth for the fallback.
 *
 * This prompt drives the SELECTION/EXTRACTION step that runs BETWEEN the
 * PropertySearch candidate pool and the existing CompsReportWriter formatter. It is
 * NOT the formatting prompt (that stays {@link import("./CompsPromptService").CompsPromptService}).
 * The engine ALWAYS re-derives the numeric fields (sale price/date used, PPSF, days
 * on market, distance) in code, so an edit here can never make a number wrong — it
 * only shifts which candidates are chosen and how they rank.
 *
 * A short-TTL cache keeps the hot text path off Postgres; an edit busts it at once.
 */
@injectable()
export class CompsSelectionPromptService {
  /** The single app_settings key backing the editable comps selection prompt. */
  static readonly KEY = "comps_selection_prompt";

  private static readonly CACHE_TTL_MS = 30_000;

  /**
   * The code DEFAULT for the editable selection prompt. Single source of truth for
   * the fallback used when nothing is stored; it MIRRORS the seed in the
   * seed_comps_selection_prompt migration. The JSON-output + only-choose-from-the-
   * list hard rules are appended by the engine and are intentionally absent here.
   */
  static readonly DEFAULT_PROMPT = [
    "You are Jake's comparable sales selection engine.",
    "",
    "Your job is to evaluate the subject property and the returned candidate sales, then select only the strongest true comparable sales. Do not format the final report — the app already handles formatting. Return only the selected comps.",
    "",
    "The candidates are recent sales pulled within a radius of the subject, already ordered nearest-first with a distance in miles on each. Do not assume every candidate is a good comp; the API returns candidates, you select the actual comps.",
    "",
    "Core objective: select the best comparable sales based on overall similarity to the subject. Prioritize, in order: same propertyType, closest distance, most recent valid sale, closest square footage, closest yearBuilt, same bedrooms, same bathrooms, closest lotSquareFeet, then same zip / county / fips. Distance is highly important because nearby sales reflect the same buyer pool and micro-market, but do not select a severely mismatched property only because it is closest.",
    "",
    "Sale price and date: each candidate already carries salePriceUsed, priceSourceUsed, and saleDateUsed derived by the app (mlsSoldPrice when MLS sold price and MLS sale date are both present, otherwise the county deed lastSaleAmount). Never use any estimated value or AVM to judge a sale price.",
    "",
    "Reject a candidate if any of these are true: propertyType does not match the subject; landUse is non-residential when the subject is residential; no usable sale price; no usable sale date; squareFeet is missing or zero; distance is greater than 10 miles; the sale is older than 365 days; squareFeet differs from the subject by more than 60%; it is a preForeclosure/distressed sale and there are enough non-distressed comps; or it is a clear pricePerSquareFoot outlier versus the rest of the usable group.",
    "",
    "Scoring (internal, do not output): Distance 30, Sale recency 20, Square footage similarity 15, Year built similarity 10, Bedroom match 7, Bathroom match 7, Lot size similarity 4, same ZIP 2, same county 2, same fips 1. Prefer comps under 0.5 mi, then under 1 mi, then under 2 mi, then under 5 mi, and beyond 5 mi only when there are not enough good closer comps. Prefer sales 0-90 days old, then 91-180, then 181-365. A very recent sale can beat a slightly closer older sale when both are otherwise similar. Compare each usable comp's pricePerSquareFoot to the median of the usable group and down-rank or reject extreme outliers (more than 35% above or below the median) unless strongly justified.",
    "",
    "Final selection: return the best 3 comps when possible; if only 1 or 2 strong comps exist, return only those; never include weak comps just to reach 3; never return more than 5. Rank them best comp first.",
  ].join("\n");

  private cache?: { value: string; at: number };

  constructor(private readonly settings: AppSettingsStore) {}

  /** The effective prompt: the admin-edited value if present, else the code default. Cached for the TTL. */
  async getEffectivePrompt(): Promise<string> {
    const now = this.clock();
    if (this.cache && now - this.cache.at < CompsSelectionPromptService.CACHE_TTL_MS) {
      return this.cache.value;
    }
    const row = await this.settings.get(CompsSelectionPromptService.KEY);
    const value = row?.value?.trim() ? row.value : CompsSelectionPromptService.DEFAULT_PROMPT;
    this.cache = { value, at: now };
    return value;
  }

  /** The full admin view: the effective prompt plus edit metadata. */
  async getView(): Promise<CompsSelectionPromptView> {
    const row = await this.settings.get(CompsSelectionPromptService.KEY);
    const stored = row?.value?.trim() ? row.value : null;
    return {
      prompt: stored ?? CompsSelectionPromptService.DEFAULT_PROMPT,
      isDefault: stored === null,
      updatedAt: stored ? row!.updated_at : null,
      updatedBy: stored ? row!.updated_by : null,
    };
  }

  /** Save an admin-edited prompt and return the fresh view; caches immediately. */
  async setPrompt(prompt: string, adminId: string | null): Promise<CompsSelectionPromptView> {
    const value = prompt.trim();
    const row = await this.settings.set(CompsSelectionPromptService.KEY, value, adminId);
    this.cache = { value, at: this.clock() };
    return { prompt: value, isDefault: false, updatedAt: row.updated_at, updatedBy: row.updated_by };
  }

  /** Revert to the code default by clearing the stored value; busts the cache. */
  async resetPrompt(): Promise<CompsSelectionPromptView> {
    await this.settings.delete(CompsSelectionPromptService.KEY);
    this.cache = undefined;
    return {
      prompt: CompsSelectionPromptService.DEFAULT_PROMPT,
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
