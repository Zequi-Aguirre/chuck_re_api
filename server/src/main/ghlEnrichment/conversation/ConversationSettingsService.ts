import { injectable } from "tsyringe";
import { AppSettingsStore } from "../../data/AppSettingsStore";

/** The admin-facing view of one editable numeric conversation setting (JAK-134). */
export interface ConversationSettingView {
  /** The effective value — the stored value, or the code default. */
  value: number;
  /** True when no admin has customized it (i.e. `value` is the code default). */
  isDefault: boolean;
  /** When it was last edited; null while it is the untouched default. */
  updatedAt: Date | null;
  /** The admin id that last edited it; null while it is the untouched default. */
  updatedBy: string | null;
}

/**
 * Owns the two admin-configurable conversation settings (JAK-134), using the
 * SAME editable pattern as the JAK-131 property-report prompt: values live in the
 * `app_settings` KV store so an admin can change them without a redeploy, with a
 * code default as the single source of truth for the fallback.
 *
 *   context_window_size      - how many recent messages a later orchestrator
 *                              (JAK-135) feeds the model as context. Default 10.
 *   free_reserve_window_days - the free re-serve window: a repeat lookup of the
 *                              same address within this many days is served free
 *                              from cache instead of hitting the paid API.
 *                              Default 5 (five) days.
 *
 * A short-TTL per-key cache keeps the hot text path from re-querying Postgres on
 * every message; an edit busts that key immediately. A stored value that isn't a
 * positive integer is ignored in favor of the default — a bad admin entry can
 * never break the flow or zero out the window.
 */
@injectable()
export class ConversationSettingsService {
  static readonly CONTEXT_WINDOW_KEY = "context_window_size";
  static readonly FREE_RESERVE_WINDOW_DAYS_KEY = "free_reserve_window_days";

  /** Code defaults — MIRROR the seed in the seed_conversation_settings migration. */
  static readonly DEFAULT_CONTEXT_WINDOW_SIZE = 10;
  static readonly DEFAULT_FREE_RESERVE_WINDOW_DAYS = 5;

  private static readonly CACHE_TTL_MS = 30_000;

  /** Per-key in-memory cache of the last effective value. */
  private readonly cache = new Map<string, { value: number; at: number }>();

  constructor(private readonly settings: AppSettingsStore) {}

  /** How many recent messages to feed a later orchestrator (JAK-135). */
  async contextWindowSize(): Promise<number> {
    return this.readInt(
      ConversationSettingsService.CONTEXT_WINDOW_KEY,
      ConversationSettingsService.DEFAULT_CONTEXT_WINDOW_SIZE
    );
  }

  /** The free re-serve window in days (default 5). */
  async freeReserveWindowDays(): Promise<number> {
    return this.readInt(
      ConversationSettingsService.FREE_RESERVE_WINDOW_DAYS_KEY,
      ConversationSettingsService.DEFAULT_FREE_RESERVE_WINDOW_DAYS
    );
  }

  /** Save an admin-edited context window size; busts the cache immediately. */
  async setContextWindowSize(value: number, adminId: string | null): Promise<ConversationSettingView> {
    return this.setInt(ConversationSettingsService.CONTEXT_WINDOW_KEY, value, adminId);
  }

  /** Save an admin-edited free re-serve window (days); busts the cache immediately. */
  async setFreeReserveWindowDays(value: number, adminId: string | null): Promise<ConversationSettingView> {
    return this.setInt(ConversationSettingsService.FREE_RESERVE_WINDOW_DAYS_KEY, value, adminId);
  }

  /** The admin view of both settings — effective values plus edit metadata. */
  async getView(): Promise<{ contextWindowSize: ConversationSettingView; freeReserveWindowDays: ConversationSettingView }> {
    const [ctx, win] = await Promise.all([
      this.viewOf(
        ConversationSettingsService.CONTEXT_WINDOW_KEY,
        ConversationSettingsService.DEFAULT_CONTEXT_WINDOW_SIZE
      ),
      this.viewOf(
        ConversationSettingsService.FREE_RESERVE_WINDOW_DAYS_KEY,
        ConversationSettingsService.DEFAULT_FREE_RESERVE_WINDOW_DAYS
      ),
    ]);
    return { contextWindowSize: ctx, freeReserveWindowDays: win };
  }

  private async readInt(key: string, fallback: number): Promise<number> {
    const now = this.clock();
    const cached = this.cache.get(key);
    if (cached && now - cached.at < ConversationSettingsService.CACHE_TTL_MS) {
      return cached.value;
    }
    const row = await this.settings.get(key);
    const value = parsePositiveInt(row?.value) ?? fallback;
    this.cache.set(key, { value, at: now });
    return value;
  }

  private async setInt(key: string, value: number, adminId: string | null): Promise<ConversationSettingView> {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`${key} must be a positive integer`);
    }
    const row = await this.settings.set(key, String(value), adminId);
    this.cache.set(key, { value, at: this.clock() });
    return { value, isDefault: false, updatedAt: row.updated_at, updatedBy: row.updated_by };
  }

  private async viewOf(key: string, fallback: number): Promise<ConversationSettingView> {
    const row = await this.settings.get(key);
    const stored = parsePositiveInt(row?.value);
    return {
      value: stored ?? fallback,
      isDefault: stored === null,
      updatedAt: stored !== null ? row!.updated_at : null,
      updatedBy: stored !== null ? row!.updated_by : null,
    };
  }

  /** Time source — a tiny indirection so tests can drive the TTL deterministically. */
  protected clock(): number {
    return Date.now();
  }
}

/**
 * Parse a stored setting value as a positive integer, or null if it's absent or
 * not a positive integer (so a bad/blank value falls back to the code default).
 */
export function parsePositiveInt(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const trimmed = String(raw).trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isInteger(n) && n > 0 ? n : null;
}
