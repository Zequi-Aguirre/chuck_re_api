import { injectable } from "tsyringe";
import { EnvConfig } from "../../config/envConfig.ts";
import { AppSettingsStore } from "../../data/AppSettingsStore.ts";
import {
  LlmProvider,
  LlmSelection,
  LlmSelectionOverride,
  normalizeProvider,
  providerKeyConfigured,
  resolveLlmSelection,
} from "./LlmSelection.ts";

/**
 * The four editable-prompt surfaces that can pin their own provider+model
 * (JAK-143). Each already has an admin-editable STYLE prompt; now it also gets an
 * optional provider+model choice, resolved with the SAME fall-back-to-global rule.
 */
export type LlmSurface =
  | "orchestrator"
  | "skiptrace"
  | "comps"
  | "comps_selection"
  | "property_report";

/** The surfaces, in admin-UI order. `comps_selection` is JAK-164's engine prompt. */
export const LLM_SURFACES: readonly LlmSurface[] = [
  "orchestrator",
  "skiptrace",
  "comps",
  "comps_selection",
  "property_report",
] as const;

/** app_settings key for a surface's stored provider+model selection. */
const KEY_FOR: Record<LlmSurface, string> = {
  orchestrator: "llm_model_orchestrator",
  skiptrace: "llm_model_skiptrace",
  comps: "llm_model_comps",
  comps_selection: "llm_model_comps_selection",
  property_report: "llm_model_property_report",
};

/**
 * The admin-facing view of a surface's provider+model setting (JAK-143). Shows
 * BOTH the stored override (null while inheriting the global default) and the
 * resolved EFFECTIVE selection, plus the global default and which provider keys
 * are configured — so the picker can render the effective default and a subtle
 * "provider key not configured — will use fallback" note. It carries NO key.
 */
export interface LlmModelSettingView {
  /** The stored provider override, or null while inheriting the global default. */
  provider: LlmProvider | null;
  /** The stored model override, or null while inheriting the provider's default. */
  model: string | null;
  /** True when no override is stored — the surface fully inherits the global default. */
  isDefault: boolean;
  /** The resolved provider this surface runs on right now. */
  effectiveProvider: LlmProvider;
  /** The resolved model this surface runs on right now. */
  effectiveModel: string;
  /** The GLOBAL default provider (Doppler LLM_PROVIDER). */
  defaultProvider: LlmProvider;
  /** The GLOBAL default model (that provider's Doppler default). */
  defaultModel: string;
  /** Which providers have a key configured in Doppler — booleans only, never keys. */
  providerKeyConfigured: Record<LlmProvider, boolean>;
  /** When the override was last edited; null while it is the untouched default. */
  updatedAt: Date | null;
  /** The admin id that last edited it; null while it is the untouched default. */
  updatedBy: string | null;
}

/** The parsed, stored override for one surface (either field may be absent). */
interface StoredSelection {
  provider: LlmProvider | null;
  model: string | null;
}

/**
 * Owns the per-surface, admin-configurable PROVIDER + MODEL selection (JAK-143),
 * using the SAME editable pattern as the JAK-131/135/136/137 prompts and the
 * JAK-137 comp params: each surface's choice lives in the `app_settings` KV store
 * (one JSON row per surface) so an admin can retarget a prompt's model without a
 * redeploy, with the JAK-141 global Doppler default as the single source of truth
 * for the fallback.
 *
 * One service fronts all four surfaces (keyed by {@link LlmSurface}) so there is
 * one place the resolution rule lives and one migration/key convention. A
 * short-TTL cache per surface keeps the hot text path off Postgres; an edit busts
 * that surface's cache immediately.
 *
 * KEYS STAY IN DOPPLER. This stores ONLY a provider name + a model id — never a
 * key. The resolved key is read from {@link EnvConfig} inside the built client,
 * never here.
 */
@injectable()
export class LlmModelSettingsService {
  private static readonly CACHE_TTL_MS = 30_000;

  /** Upper bound on a stored model id — a sane guardrail, not a real limit. */
  static readonly MAX_MODEL_LENGTH = 100;

  private readonly cache = new Map<LlmSurface, { value: StoredSelection | null; at: number }>();

  constructor(
    private readonly settings: AppSettingsStore,
    private readonly env: EnvConfig
  ) {}

  /**
   * The EFFECTIVE {provider, model} for a surface: the stored override resolved
   * against the global Doppler default (JAK-141). This is what the router/writer
   * passes to the client resolver. Cached for {@link CACHE_TTL_MS}.
   */
  async getEffectiveSelection(surface: LlmSurface): Promise<LlmSelection> {
    const stored = await this.getStored(surface);
    return this.resolve(stored);
  }

  /** The full admin view: the stored override, the effective selection, and metadata. */
  async getView(surface: LlmSurface): Promise<LlmModelSettingView> {
    const row = await this.settings.get(KEY_FOR[surface]);
    const stored = parseStored(row?.value);
    const effective = this.resolve(stored);
    const globalDefault = resolveLlmSelection(this.env, null);
    return {
      provider: stored?.provider ?? null,
      model: stored?.model ?? null,
      isDefault: stored === null,
      effectiveProvider: effective.provider,
      effectiveModel: effective.model,
      defaultProvider: globalDefault.provider,
      defaultModel: globalDefault.model,
      providerKeyConfigured: providerKeyConfigured(this.env),
      updatedAt: stored !== null ? row!.updated_at : null,
      updatedBy: stored !== null ? row!.updated_by : null,
    };
  }

  /**
   * Pin a surface's provider (+ optional model). `provider` MUST be a known
   * provider; a blank model means "use the provider's default model" (stored as
   * null → resolves to the Doppler default). Busts the cache immediately so the
   * very next router/writer call uses the new selection.
   */
  async setSelection(
    surface: LlmSurface,
    provider: LlmProvider,
    model: string | null,
    adminId: string | null
  ): Promise<LlmModelSettingView> {
    const normalizedModel = model?.trim() ? model.trim() : null;
    const stored: StoredSelection = { provider, model: normalizedModel };
    await this.settings.set(KEY_FOR[surface], JSON.stringify(stored), adminId);
    this.cache.set(surface, { value: stored, at: this.clock() });
    return this.getView(surface);
  }

  /** Revert a surface to the global default by clearing its stored override; busts the cache. */
  async reset(surface: LlmSurface): Promise<LlmModelSettingView> {
    await this.settings.delete(KEY_FOR[surface]);
    this.cache.set(surface, { value: null, at: this.clock() });
    return this.getView(surface);
  }

  /** Read + cache the stored override for a surface (null when inheriting the default). */
  private async getStored(surface: LlmSurface): Promise<StoredSelection | null> {
    const now = this.clock();
    const cached = this.cache.get(surface);
    if (cached && now - cached.at < LlmModelSettingsService.CACHE_TTL_MS) {
      return cached.value;
    }
    const row = await this.settings.get(KEY_FOR[surface]);
    const value = parseStored(row?.value);
    this.cache.set(surface, { value, at: now });
    return value;
  }

  /** Resolve a stored override to a concrete {provider, model} via the shared rule. */
  private resolve(stored: StoredSelection | null): LlmSelection {
    const override: LlmSelectionOverride = {
      provider: stored?.provider ?? null,
      model: stored?.model ?? null,
    };
    return resolveLlmSelection(this.env, override);
  }

  /** Time source — a tiny indirection so tests can drive the TTL deterministically. */
  protected clock(): number {
    return Date.now();
  }
}

/**
 * Parse a stored selection JSON into a {@link StoredSelection}, or null when the
 * value is absent/blank/garbage or carries no usable override — so a corrupt row
 * degrades cleanly to "use the global default" rather than throwing on the hot
 * path. A provider that isn't a known provider is dropped; a non-string model is
 * dropped. A row with NEITHER a usable provider nor model is treated as no
 * override (null).
 */
function parseStored(raw: string | null | undefined): StoredSelection | null {
  if (!raw || !raw.trim()) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const src = obj as Record<string, unknown>;

  const provider =
    typeof src.provider === "string" && src.provider.trim()
      ? normalizeProvider(src.provider)
      : null;
  const model =
    typeof src.model === "string" && src.model.trim() ? src.model.trim() : null;

  if (provider === null && model === null) return null;
  return { provider, model };
}
