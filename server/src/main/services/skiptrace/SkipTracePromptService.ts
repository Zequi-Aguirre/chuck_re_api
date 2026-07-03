import { injectable } from "tsyringe";
import { AppSettingsStore } from "../../data/AppSettingsStore";

/** The admin-facing view of the editable skip-trace specialist prompt (JAK-136). */
export interface SkipTracePromptView {
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
 * Owns the editable STYLE prompt for the text-Jake skip-trace specialist
 * (JAK-136), using the SAME editable pattern as the JAK-135 orchestrator prompt
 * and the JAK-131 report prompt: the value lives in the `app_settings` KV store so
 * an admin can tune how Jake presents owner/contact info without a redeploy, with
 * a code default as the single source of truth for the fallback.
 *
 * This is the STYLE layer ONLY — how to phrase the owner/contact summary. The
 * HARD GUARDRAILS (no emojis, only-provided-values, the GoTextJake.com footer) are
 * appended in code by {@link import("./SkipTraceReportWriter").SkipTraceReportWriter}
 * and enforced on the OUTPUT, so an admin editing this prompt can never make Jake
 * invent contact info, add emojis, or drop the footer.
 *
 * A short-TTL cache keeps the hot text path from re-querying Postgres on every
 * skip trace; an edit busts the cache immediately.
 */
@injectable()
export class SkipTracePromptService {
  /** The single app_settings key backing the editable skip-trace prompt. */
  static readonly KEY = "skiptrace_prompt";

  /** How long a cached read stays fresh before we re-query Postgres. */
  private static readonly CACHE_TTL_MS = 30_000;

  /**
   * The code DEFAULT for the editable skip-trace prompt. Single source of truth
   * for the fallback used when nothing is stored; it MIRRORS the seed in the
   * seed_skiptrace_settings migration. The HARD guardrails are intentionally
   * absent here — they are appended by the writer.
   */
  static readonly DEFAULT_PROMPT = [
    "You are Jake, a real-estate assistant, texting back the results of an owner skip trace as a concise, plain-text SMS.",
    "",
    "You are given VERIFIED contact data for a property's owner: their name, phone number(s), email(s), and mailing address — whichever the trace returned.",
    "",
    "Write a short reply that:",
    "- Leads with the owner's name and the property it's for.",
    "- Lists the phone number(s) clearly, one per line, since that's what the user most wants.",
    "- Includes email(s) and the mailing address when present.",
    "- Skips anything the data does not include — never say 'not available' or leave a blank label.",
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
    if (this.cache && now - this.cache.at < SkipTracePromptService.CACHE_TTL_MS) {
      return this.cache.value;
    }
    const row = await this.settings.get(SkipTracePromptService.KEY);
    const value = row?.value?.trim() ? row.value : SkipTracePromptService.DEFAULT_PROMPT;
    this.cache = { value, at: now };
    return value;
  }

  /** The full admin view: the effective prompt plus edit metadata. */
  async getView(): Promise<SkipTracePromptView> {
    const row = await this.settings.get(SkipTracePromptService.KEY);
    const stored = row?.value?.trim() ? row.value : null;
    return {
      prompt: stored ?? SkipTracePromptService.DEFAULT_PROMPT,
      isDefault: stored === null,
      updatedAt: stored ? row!.updated_at : null,
      updatedBy: stored ? row!.updated_by : null,
    };
  }

  /**
   * Save an admin-edited prompt and return the fresh view. The new value is
   * cached immediately so the very next skip trace reflects the edit.
   */
  async setPrompt(prompt: string, adminId: string | null): Promise<SkipTracePromptView> {
    const value = prompt.trim();
    const row = await this.settings.set(SkipTracePromptService.KEY, value, adminId);
    this.cache = { value, at: this.clock() };
    return { prompt: value, isDefault: false, updatedAt: row.updated_at, updatedBy: row.updated_by };
  }

  /**
   * Revert to the code default by clearing the stored value. Busts the cache so
   * the next read uses the default immediately.
   */
  async resetPrompt(): Promise<SkipTracePromptView> {
    await this.settings.delete(SkipTracePromptService.KEY);
    this.cache = undefined;
    return {
      prompt: SkipTracePromptService.DEFAULT_PROMPT,
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
