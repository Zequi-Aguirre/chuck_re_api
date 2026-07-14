import { injectable } from "tsyringe";
import { AppSettingsStore } from "../../data/AppSettingsStore";
import { CreditType } from "./CreditCosts";

/**
 * Parse a stored setting value as a NON-NEGATIVE integer, or null if it's absent
 * or malformed (so a bad/blank value falls back to the code default). Distinct
 * from {@link import("../conversation/ConversationSettingsService").parsePositiveInt}:
 * a new-customer default grant of 0 is legitimate (an admin may want a feature to
 * start empty), so 0 is a VALID stored value here.
 */
export function parseNonNegativeInt(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const trimmed = String(raw).trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** The admin-facing view of one editable new-customer default grant (JAK-161). */
export interface CreditDefaultView {
  type: CreditType;
  /** The effective opening grant in credits — the stored value, or the code default. */
  value: number;
  /** True when no admin has customized it (i.e. `value` is the code default). */
  isDefault: boolean;
  updatedAt: Date | null;
  updatedBy: string | null;
}

/** The admin-facing view of one editable out-of-credits message (JAK-161). */
export interface OutOfCreditsMessageView {
  type: CreditType;
  /** The effective message body — the stored value, or the code default. Footer NOT included. */
  value: string;
  /** True when no admin has customized it. */
  isDefault: boolean;
  updatedAt: Date | null;
  updatedBy: string | null;
}

/**
 * Owns the admin-configurable NEW-CUSTOMER DEFAULT GRANTS and the per-feature
 * OUT-OF-CREDITS MESSAGES for the three credit buckets (JAK-161), using the SAME
 * editable `app_settings` pattern as the JAK-136 skip-trace cost and JAK-131
 * report prompt: values live in the KV store so an admin can retune the
 * economics + the copy without a redeploy, with code defaults as the single
 * source of truth for the fallbacks.
 *
 *   report    — freely granted (default 50), still gated.
 *   skiptrace — PAID (default opening grant 10).
 *   comps     — PAID (default opening grant 10).
 *
 * On customer creation the three balances are seeded from {@link defaultGrant}.
 * When a bucket is empty the specialist replies {@link outOfCreditsMessage} —
 * emoji-free copy pointing the texter at an admin; the canonical JAK-158 SMS
 * footer is appended by the sender, so it can never be edited away. There is NO
 * self-serve checkout. Short-TTL caches keep the hot text path off Postgres; an
 * edit busts them immediately. The seeds in the JAK-161 migration MIRROR the code
 * defaults below.
 */
@injectable()
export class CreditSettingsService {
  /**
   * Code-default opening grants (the fallback when `app_settings` has no stored
   * value). report=50 per JAK-report-default-50 — the JAK-161 seed of 100 was a
   * voice-to-text slip; the corrective migration flips any still-100 stored value
   * to 50, so the effective default matches this constant.
   */
  static readonly DEFAULT_GRANTS: Readonly<Record<CreditType, number>> = {
    report: 50,
    skiptrace: 10,
    comps: 10,
  };

  /** Code-default out-of-credits copy (footer appended by the sender, not here). */
  static readonly DEFAULT_MESSAGES: Readonly<Record<CreditType, string>> = {
    report: "You're out of report credits. To get more, contact an admin.",
    skiptrace: "You're out of skip-trace credits. To get more, contact an admin.",
    comps: "You're out of comps credits. To get more, contact an admin.",
  };

  private static readonly CACHE_TTL_MS = 30_000;

  private grantCache = new Map<CreditType, { value: number; at: number }>();
  private messageCache = new Map<CreditType, { value: string; at: number }>();

  constructor(private readonly settings: AppSettingsStore) {}

  /** The `app_settings` key backing a bucket's new-customer default grant. */
  static defaultCreditsKey(type: CreditType): string {
    return `default_${type}_credits`;
  }

  /** The `app_settings` key backing a bucket's out-of-credits message. */
  static messageKey(type: CreditType): string {
    return `out_of_credits_message_${type}`;
  }

  // ── New-customer default grants ─────────────────────────────────────────────

  /** The effective opening grant for a bucket (default 50/10/10). Cached for the TTL. */
  async defaultGrant(type: CreditType): Promise<number> {
    const now = this.clock();
    const cached = this.grantCache.get(type);
    if (cached && now - cached.at < CreditSettingsService.CACHE_TTL_MS) {
      return cached.value;
    }
    const row = await this.settings.get(CreditSettingsService.defaultCreditsKey(type));
    const value = parseNonNegativeInt(row?.value) ?? CreditSettingsService.DEFAULT_GRANTS[type];
    this.grantCache.set(type, { value, at: now });
    return value;
  }

  /** The admin view of one bucket's default grant + edit metadata. */
  async getDefaultView(type: CreditType): Promise<CreditDefaultView> {
    const row = await this.settings.get(CreditSettingsService.defaultCreditsKey(type));
    const stored = parseNonNegativeInt(row?.value);
    return {
      type,
      value: stored ?? CreditSettingsService.DEFAULT_GRANTS[type],
      isDefault: stored === null,
      updatedAt: stored !== null ? row!.updated_at : null,
      updatedBy: stored !== null ? row!.updated_by : null,
    };
  }

  /** The admin view of all three default grants. */
  async getDefaultViews(): Promise<CreditDefaultView[]> {
    return Promise.all(
      (Object.keys(CreditSettingsService.DEFAULT_GRANTS) as CreditType[]).map((t) =>
        this.getDefaultView(t)
      )
    );
  }

  /** Save an admin-edited default grant (non-negative integer); busts the cache. */
  async setDefaultGrant(type: CreditType, value: number, adminId: string | null): Promise<CreditDefaultView> {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`${CreditSettingsService.defaultCreditsKey(type)} must be a non-negative integer`);
    }
    const row = await this.settings.set(
      CreditSettingsService.defaultCreditsKey(type),
      String(value),
      adminId
    );
    this.grantCache.set(type, { value, at: this.clock() });
    return { type, value, isDefault: false, updatedAt: row.updated_at, updatedBy: row.updated_by };
  }

  /** Revert a bucket's default grant to the code default (clears the stored value). */
  async resetDefaultGrant(type: CreditType): Promise<CreditDefaultView> {
    await this.settings.delete(CreditSettingsService.defaultCreditsKey(type));
    this.grantCache.delete(type);
    return {
      type,
      value: CreditSettingsService.DEFAULT_GRANTS[type],
      isDefault: true,
      updatedAt: null,
      updatedBy: null,
    };
  }

  // ── Out-of-credits messages ─────────────────────────────────────────────────

  /**
   * The effective out-of-credits message for a bucket (footer NOT appended — the
   * sender adds the canonical JAK-158 footer). A blank/absent stored value falls
   * back to the code default. Cached for the TTL.
   */
  async outOfCreditsMessage(type: CreditType): Promise<string> {
    const now = this.clock();
    const cached = this.messageCache.get(type);
    if (cached && now - cached.at < CreditSettingsService.CACHE_TTL_MS) {
      return cached.value;
    }
    const row = await this.settings.get(CreditSettingsService.messageKey(type));
    const stored = row?.value?.trim();
    const value = stored ? stored : CreditSettingsService.DEFAULT_MESSAGES[type];
    this.messageCache.set(type, { value, at: now });
    return value;
  }

  /** The admin view of one bucket's out-of-credits message + edit metadata. */
  async getMessageView(type: CreditType): Promise<OutOfCreditsMessageView> {
    const row = await this.settings.get(CreditSettingsService.messageKey(type));
    const stored = row?.value?.trim() ? row.value : null;
    return {
      type,
      value: stored ?? CreditSettingsService.DEFAULT_MESSAGES[type],
      isDefault: stored === null,
      updatedAt: stored !== null ? row!.updated_at : null,
      updatedBy: stored !== null ? row!.updated_by : null,
    };
  }

  /** The admin view of all three out-of-credits messages. */
  async getMessageViews(): Promise<OutOfCreditsMessageView[]> {
    return Promise.all(
      (Object.keys(CreditSettingsService.DEFAULT_MESSAGES) as CreditType[]).map((t) =>
        this.getMessageView(t)
      )
    );
  }

  /** Save an admin-edited out-of-credits message (non-empty); busts the cache. */
  async setMessage(type: CreditType, message: string, adminId: string | null): Promise<OutOfCreditsMessageView> {
    const trimmed = typeof message === "string" ? message.trim() : "";
    if (!trimmed) {
      throw new Error(`${CreditSettingsService.messageKey(type)} must be a non-empty message`);
    }
    const row = await this.settings.set(CreditSettingsService.messageKey(type), trimmed, adminId);
    this.messageCache.set(type, { value: trimmed, at: this.clock() });
    return { type, value: trimmed, isDefault: false, updatedAt: row.updated_at, updatedBy: row.updated_by };
  }

  /** Revert a bucket's out-of-credits message to the code default. */
  async resetMessage(type: CreditType): Promise<OutOfCreditsMessageView> {
    await this.settings.delete(CreditSettingsService.messageKey(type));
    this.messageCache.delete(type);
    return {
      type,
      value: CreditSettingsService.DEFAULT_MESSAGES[type],
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
