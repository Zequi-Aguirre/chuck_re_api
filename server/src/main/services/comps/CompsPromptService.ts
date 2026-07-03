import { injectable } from "tsyringe";
import { AppSettingsStore } from "../../data/AppSettingsStore";

/** The admin-facing view of the editable comps specialist prompt (JAK-137). */
export interface CompsPromptView {
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
 * Owns the editable STYLE prompt for the text-Jake comps specialist (JAK-137),
 * using the SAME editable pattern as the JAK-136 skip-trace prompt, the JAK-135
 * orchestrator prompt, and the JAK-131 report prompt: the value lives in the
 * `app_settings` KV store so an admin can tune how Jake presents comparable sales
 * without a redeploy, with a code default as the single source of truth for the
 * fallback.
 *
 * This is the STYLE layer ONLY — how to phrase the comps summary. The HARD
 * GUARDRAILS (no emojis, only-provided-values, the GoTextJake.com footer) are
 * appended in code by {@link import("./CompsReportWriter").CompsReportWriter} and
 * enforced on the OUTPUT, so an admin editing this prompt can never make Jake
 * invent a comp or a price, add emojis, or drop the footer.
 *
 * A short-TTL cache keeps the hot text path from re-querying Postgres on every
 * comps pull; an edit busts the cache immediately.
 */
@injectable()
export class CompsPromptService {
  /** The single app_settings key backing the editable comps prompt. */
  static readonly KEY = "comps_prompt";

  /** How long a cached read stays fresh before we re-query Postgres. */
  private static readonly CACHE_TTL_MS = 30_000;

  /**
   * The code DEFAULT for the editable comps prompt. Single source of truth for the
   * fallback used when nothing is stored; it MIRRORS the seed in the
   * seed_comps_settings migration. The HARD guardrails are intentionally absent
   * here — they are appended by the writer.
   */
  static readonly DEFAULT_PROMPT = [
    "You are Jake, a real-estate assistant, texting back a comparable-sales (comps) summary as a concise, plain-text SMS.",
    "",
    "You are given VERIFIED comparable sales for a subject property: for each comp its address, sale price, beds/baths/square feet, distance from the subject, and sale date — whichever the data returned. You may also be given an estimated value range for the subject.",
    "",
    "Write a short reply that:",
    "- Opens with the subject address and the parameters used (search radius, number of comps, timeframe, and bed/bath/sqft tolerance).",
    "- Lists each comparable on its own compact block: address, sale price, then beds/baths/sqft and distance/date when present.",
    "- Ends with a one-line summary — an average or estimated range — ONLY if the data supports it.",
    "- Skips anything the data does not include — never say 'not available' or leave a blank label, and never invent a comp or a price.",
    "",
    "Keep it tight and skimmable on a phone. No preamble, no sign-off beyond the footer.",
  ].join("\n");

  /** In-memory cache of the last effective prompt (value + when it was cached). */
  private cache?: { value: string; at: number };

  constructor(private readonly settings: AppSettingsStore) {}

  /**
   * The effective prompt for the specialist: the admin-edited value if present,
   * otherwise the code default. Cached for {@link CACHE_TTL_MS}.
   */
  async getEffectivePrompt(): Promise<string> {
    const now = this.clock();
    if (this.cache && now - this.cache.at < CompsPromptService.CACHE_TTL_MS) {
      return this.cache.value;
    }
    const row = await this.settings.get(CompsPromptService.KEY);
    const value = row?.value?.trim() ? row.value : CompsPromptService.DEFAULT_PROMPT;
    this.cache = { value, at: now };
    return value;
  }

  /** The full admin view: the effective prompt plus edit metadata. */
  async getView(): Promise<CompsPromptView> {
    const row = await this.settings.get(CompsPromptService.KEY);
    const stored = row?.value?.trim() ? row.value : null;
    return {
      prompt: stored ?? CompsPromptService.DEFAULT_PROMPT,
      isDefault: stored === null,
      updatedAt: stored ? row!.updated_at : null,
      updatedBy: stored ? row!.updated_by : null,
    };
  }

  /**
   * Save an admin-edited prompt and return the fresh view. The new value is cached
   * immediately so the very next comps pull reflects the edit.
   */
  async setPrompt(prompt: string, adminId: string | null): Promise<CompsPromptView> {
    const value = prompt.trim();
    const row = await this.settings.set(CompsPromptService.KEY, value, adminId);
    this.cache = { value, at: this.clock() };
    return { prompt: value, isDefault: false, updatedAt: row.updated_at, updatedBy: row.updated_by };
  }

  /**
   * Revert to the code default by clearing the stored value. Busts the cache so the
   * next read uses the default immediately.
   */
  async resetPrompt(): Promise<CompsPromptView> {
    await this.settings.delete(CompsPromptService.KEY);
    this.cache = undefined;
    return {
      prompt: CompsPromptService.DEFAULT_PROMPT,
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
