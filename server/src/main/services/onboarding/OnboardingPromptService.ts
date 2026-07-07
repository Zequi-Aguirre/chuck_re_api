import { injectable } from "tsyringe";
import { AppSettingsStore } from "../../data/AppSettingsStore";

/** The admin-facing view of the editable onboarding email-ask prompt. */
export interface OnboardingPromptView {
  /** The effective ask wording — the stored value, or the code default. */
  prompt: string;
  /** True when no admin has customized it, i.e. `prompt` is the code default. */
  isDefault: boolean;
  /** When it was last edited; null while it is the untouched default. */
  updatedAt: Date | null;
  /** The admin id that last edited it; null while it is the untouched default. */
  updatedBy: string | null;
}

/**
 * Owns the editable wording of the DELAYED onboarding email ask
 * (JAK-first-text-welcome) — the message Jake sends once, right after a customer's
 * 3rd report, inviting them to share a name + email so the full report can be
 * emailed to them.
 *
 * Same admin-editable `app_settings` pattern as {@link import("../PropertyReportPromptService").PropertyReportPromptService}
 * and the out-of-credits messages: a short-TTL cache fronts Postgres so the hot
 * text path never hammers the DB, an edit busts the cache immediately, and the
 * code {@link DEFAULT_PROMPT} is the single source of truth for the fallback (it
 * MIRRORS the seed in the JAK-first-text-welcome migration). The GoTextJake.com
 * footer is appended by the SENDER, never stored here, so it can't be edited away.
 *
 * NOTE: this ticket only ASKS for the email and captures it. Actually EMAILING a
 * report is a separate, unbuilt feature — nothing here sends email.
 */
@injectable()
export class OnboardingPromptService {
  /** The single app_settings key backing the editable ask. */
  static readonly KEY = "onboarding_email_ask_prompt";

  /** How long a cached read stays fresh before we re-query Postgres. */
  private static readonly CACHE_TTL_MS = 30_000;

  /**
   * The code DEFAULT wording (fallback when nothing is stored). MIRRORS the seed
   * in the JAK-first-text-welcome migration. Emoji-free, TTS-friendly; the footer
   * is appended by the sender.
   */
  static readonly DEFAULT_PROMPT =
    "Hey, we're getting to know each other. If you'd like the full report emailed to you, send me your name and email.";

  private cache?: { value: string; at: number };

  constructor(private readonly settings: AppSettingsStore) {}

  /**
   * The effective ask wording for the sender: the admin-edited value if present,
   * else the code default. Cached for {@link CACHE_TTL_MS}.
   */
  async getEffectivePrompt(): Promise<string> {
    const now = this.clock();
    if (this.cache && now - this.cache.at < OnboardingPromptService.CACHE_TTL_MS) {
      return this.cache.value;
    }
    const row = await this.settings.get(OnboardingPromptService.KEY);
    const value = row?.value?.trim() ? row.value : OnboardingPromptService.DEFAULT_PROMPT;
    this.cache = { value, at: now };
    return value;
  }

  /** The full admin view: the effective prompt plus edit metadata. */
  async getView(): Promise<OnboardingPromptView> {
    const row = await this.settings.get(OnboardingPromptService.KEY);
    const stored = row?.value?.trim() ? row.value : null;
    return {
      prompt: stored ?? OnboardingPromptService.DEFAULT_PROMPT,
      isDefault: stored === null,
      updatedAt: stored ? row!.updated_at : null,
      updatedBy: stored ? row!.updated_by : null,
    };
  }

  /** Save an admin-edited ask and return the fresh view; busts the cache. */
  async setPrompt(prompt: string, adminId: string | null): Promise<OnboardingPromptView> {
    const value = prompt.trim();
    const row = await this.settings.set(OnboardingPromptService.KEY, value, adminId);
    this.cache = { value, at: this.clock() };
    return { prompt: value, isDefault: false, updatedAt: row.updated_at, updatedBy: row.updated_by };
  }

  /** Revert to the code default by clearing the stored value; busts the cache. */
  async resetPrompt(): Promise<OnboardingPromptView> {
    await this.settings.delete(OnboardingPromptService.KEY);
    this.cache = undefined;
    return {
      prompt: OnboardingPromptService.DEFAULT_PROMPT,
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
