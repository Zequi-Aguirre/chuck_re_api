import { injectable } from "tsyringe";
import { AppSettingsStore } from "../data/AppSettingsStore";

/** The admin-facing view of the editable property-report prompt (JAK-131). */
export interface PropertyReportPromptView {
  /** The effective STYLE/FORMAT prompt — the stored value, or the code default. */
  prompt: string;
  /** True when no admin has customized it, i.e. `prompt` is the code default. */
  isDefault: boolean;
  /** When it was last edited; null while it is the untouched default. */
  updatedAt: Date | null;
  /** The admin id that last edited it; null while it is the untouched default. */
  updatedBy: string | null;
}

/**
 * Owns the editable STYLE/FORMAT prompt for the "Jake Property Report" (JAK-131).
 *
 * This is the STYLE layer ONLY — tone, structure, which sections to show and how
 * to format them. The HARD GUARDRAILS (no emojis, use only provided values, the
 * GoTextJake.com footer) are NOT stored here: {@link PropertyReportWriter}
 * enforces them in code around whatever this returns, so an admin editing the
 * prompt can never remove them.
 *
 * A single singleton fronts the {@link AppSettingsStore} with a short-TTL cache
 * so the writer can read the prompt on every SMS without hammering Postgres. An
 * edit through {@link setPrompt}/{@link resetPrompt} busts the cache immediately,
 * so a saved change is reflected on the very next report — while the TTL bounds
 * staleness across other server instances.
 */
@injectable()
export class PropertyReportPromptService {
  /** The single app_settings key backing the editable prompt. */
  static readonly KEY = "property_report_prompt";

  /** How long a cached read stays fresh before we re-query Postgres. */
  private static readonly CACHE_TTL_MS = 30_000;

  /**
   * The code DEFAULT for the editable STYLE prompt (JAK-130 report, JAK-131
   * grouped-section redesign). Single source of truth for the fallback used when
   * nothing is stored; it MIRRORS the seed in the create_app_settings migration.
   * Guardrails are intentionally absent here — they are appended by the writer.
   */
  static readonly DEFAULT_STYLE_PROMPT = [
    'Write a "Jake Property Report" as a clean, scannable plain-text SMS.',
    "",
    "You receive the full verified property record plus a block of derived highlights. Use whichever fields are useful; you do not have to include every field.",
    "",
    "Lay it out as grouped sections separated by a single blank line. Include a section ONLY when the data has at least one relevant field; silently drop any section or field that has no data.",
    "",
    "1. A headline line: Jake Property Report",
    "2. The property address (street on its own line; the city, state and ZIP on the next line when provided).",
    '3. Property - property type, beds and baths (for example "4 Beds | 2 Baths"), square footage, lot size, year built.',
    "4. Estimated Market Value - the estimated market value.",
    "5. Ownership - owner name(s), equity (percent and whether it is free and clear), equity level, occupancy, absentee status, years owned.",
    "6. Financials - estimated mortgage balance (openMortgageBalance), estimated mortgage payment (estimatedMortgagePayment), and estimated equity in dollars (estimatedEquity). Include only the ones present.",
    "7. Distress / Liens - foreclosure, pre-foreclosure, bank-owned/REO, auction (with its date if given), tax lien, and judgment.",
    "8. History - last sold date and sale price.",
    "9. Additional Information - FEMA flood zone, MLS listing status, and any other useful provided facts.",
    "",
    "Distress and lien rules (read carefully):",
    "- foreclosure, preForeclosure, reo, auction, taxLien and judgment are Yes/No FLAGS, not amounts. There is NO dollar figure for liens - never invent or imply one.",
    "- List a distress or lien item ONLY when its flag is true (for example, print \"Tax Lien\" only when taxLien is true).",
    "- A flag that is false or absent means it is NOT on record. Do NOT print it, and never write the words \"false\", \"true\", \"null\", or the raw field name.",
    "- If every distress and lien flag is false or absent, either omit the Distress / Liens section entirely or show a single reassuring line: \"No liens or foreclosure on record\".",
    "",
    "Formatting:",
    '- Put each section\'s label on its own line, then list that section\'s facts as "- " bullets on the lines below it.',
    "- Leave exactly one blank line between sections.",
    "- Format numbers with thousands separators and prices with a leading $.",
    "- Keep the tone warm but concise - this is a text message, not a brochure.",
  ].join("\n");

  /** In-memory cache of the last effective prompt (value + when it was cached). */
  private cache?: { value: string; at: number };

  constructor(private readonly settings: AppSettingsStore) {}

  /**
   * The effective STYLE prompt for the writer: the admin-edited value if present,
   * otherwise the code default. Cached for {@link CACHE_TTL_MS}.
   */
  async getEffectivePrompt(): Promise<string> {
    const now = this.clock();
    if (this.cache && now - this.cache.at < PropertyReportPromptService.CACHE_TTL_MS) {
      return this.cache.value;
    }
    const row = await this.settings.get(PropertyReportPromptService.KEY);
    const value = row?.value?.trim()
      ? row.value
      : PropertyReportPromptService.DEFAULT_STYLE_PROMPT;
    this.cache = { value, at: now };
    return value;
  }

  /** The full admin view: the effective prompt plus edit metadata. */
  async getView(): Promise<PropertyReportPromptView> {
    const row = await this.settings.get(PropertyReportPromptService.KEY);
    const stored = row?.value?.trim() ? row.value : null;
    return {
      prompt: stored ?? PropertyReportPromptService.DEFAULT_STYLE_PROMPT,
      isDefault: stored === null,
      updatedAt: stored ? row!.updated_at : null,
      updatedBy: stored ? row!.updated_by : null,
    };
  }

  /**
   * Save an admin-edited prompt and return the fresh view. The new value is
   * cached immediately so the very next report reflects the edit.
   */
  async setPrompt(prompt: string, adminId: string | null): Promise<PropertyReportPromptView> {
    const value = prompt.trim();
    const row = await this.settings.set(PropertyReportPromptService.KEY, value, adminId);
    this.cache = { value, at: this.clock() };
    return { prompt: value, isDefault: false, updatedAt: row.updated_at, updatedBy: row.updated_by };
  }

  /**
   * Revert to the code default by clearing the stored value. Busts the cache so
   * the next read (and the next report) uses the default immediately.
   */
  async resetPrompt(): Promise<PropertyReportPromptView> {
    await this.settings.delete(PropertyReportPromptService.KEY);
    this.cache = undefined;
    return {
      prompt: PropertyReportPromptService.DEFAULT_STYLE_PROMPT,
      isDefault: true,
      updatedAt: null,
      updatedBy: null,
    };
  }

  /**
   * Time source. A tiny indirection so this doesn't rely on `Date.now()` being
   * mockable — tests can subclass to drive the TTL deterministically.
   */
  protected clock(): number {
    return Date.now();
  }
}
