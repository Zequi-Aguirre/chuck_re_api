import { injectable } from "tsyringe";
import { AppSettingsStore } from "../../data/AppSettingsStore.ts";

/** The admin-facing view of the editable orchestrator/router prompt (JAK-135). */
export interface OrchestratorPromptView {
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
 * Owns the editable STYLE/CLASSIFICATION prompt for the text-Jake orchestrator
 * (JAK-135), using the SAME editable pattern as the JAK-131 property-report
 * prompt: the value lives in the `app_settings` KV store so an admin can tune how
 * Jake interprets messages without a redeploy, with a code default as the single
 * source of truth for the fallback.
 *
 * This is the STYLE layer ONLY — how to read intent and references. The HARD
 * classification rules (the fixed intent set, the JSON-only output, the
 * never-invent-an-address rule) are appended in code by
 * {@link import("./RouterLlmClient").AnthropicRouterLlmClient}, so an admin
 * editing this prompt can never break routing.
 *
 * A short-TTL cache keeps the hot text path from re-querying Postgres on every
 * inbound; an edit busts the cache immediately.
 */
@injectable()
export class OrchestratorPromptService {
  /** The single app_settings key backing the editable orchestrator prompt. */
  static readonly KEY = "orchestrator_prompt";

  /** How long a cached read stays fresh before we re-query Postgres. */
  private static readonly CACHE_TTL_MS = 30_000;

  /**
   * The code DEFAULT for the editable orchestrator prompt. Single source of truth
   * for the fallback used when nothing is stored; it MIRRORS the seed in the
   * seed_orchestrator_prompt migration. The HARD rules are intentionally absent
   * here — they are appended by the router client.
   */
  static readonly DEFAULT_PROMPT = [
    "You route inbound texts for Jake, a real-estate assistant. Decide what the person wants so the right specialist runs.",
    "",
    "Jake can do these things:",
    "- Pull a property report for an address (owner, value, equity, distress signals).",
    "- Skip-trace an owner to find contact info (coming soon).",
    "- Pull comparable sales / a CMA for a property (coming soon).",
    "",
    "How to read messages:",
    "- A full or partial street address means the person wants a property report on it.",
    "- People refer back to addresses they already sent: 'the 2nd one', 'the last address', 'that property'. Resolve these against the ordered resolved-address list, newest sends at the bottom.",
    "- A bare 'OK', 'yes', or 'yeah' right after Jake offered a fresh paid copy means: refresh the last address.",
    "- 'Who owns it', 'find the owner', 'skip trace' means a skip-trace request.",
    "- 'Comps', 'comparables', 'what did nearby homes sell for' means a comps request.",
    "- Greetings, thanks, or anything you can't map is chitchat.",
    "",
    "Prefer resolving a reference to an existing address over guessing. When you are unsure which address is meant, do not invent one.",
  ].join("\n");

  /** In-memory cache of the last effective prompt (value + when it was cached). */
  private cache?: { value: string; at: number };

  constructor(private readonly settings: AppSettingsStore) {}

  /**
   * The effective prompt for the router: the admin-edited value if present,
   * otherwise the code default. Cached for {@link CACHE_TTL_MS}.
   */
  async getEffectivePrompt(): Promise<string> {
    const now = this.clock();
    if (this.cache && now - this.cache.at < OrchestratorPromptService.CACHE_TTL_MS) {
      return this.cache.value;
    }
    const row = await this.settings.get(OrchestratorPromptService.KEY);
    const value = row?.value?.trim() ? row.value : OrchestratorPromptService.DEFAULT_PROMPT;
    this.cache = { value, at: now };
    return value;
  }

  /** The full admin view: the effective prompt plus edit metadata. */
  async getView(): Promise<OrchestratorPromptView> {
    const row = await this.settings.get(OrchestratorPromptService.KEY);
    const stored = row?.value?.trim() ? row.value : null;
    return {
      prompt: stored ?? OrchestratorPromptService.DEFAULT_PROMPT,
      isDefault: stored === null,
      updatedAt: stored ? row!.updated_at : null,
      updatedBy: stored ? row!.updated_by : null,
    };
  }

  /**
   * Save an admin-edited prompt and return the fresh view. The new value is
   * cached immediately so the very next classification reflects the edit.
   */
  async setPrompt(prompt: string, adminId: string | null): Promise<OrchestratorPromptView> {
    const value = prompt.trim();
    const row = await this.settings.set(OrchestratorPromptService.KEY, value, adminId);
    this.cache = { value, at: this.clock() };
    return { prompt: value, isDefault: false, updatedAt: row.updated_at, updatedBy: row.updated_by };
  }

  /**
   * Revert to the code default by clearing the stored value. Busts the cache so
   * the next read uses the default immediately.
   */
  async resetPrompt(): Promise<OrchestratorPromptView> {
    await this.settings.delete(OrchestratorPromptService.KEY);
    this.cache = undefined;
    return {
      prompt: OrchestratorPromptService.DEFAULT_PROMPT,
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
