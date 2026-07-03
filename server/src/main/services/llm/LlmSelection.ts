import { EnvConfig } from "../../config/envConfig.ts";

/**
 * JAK-143 — the per-call PROVIDER + MODEL selection layer over the JAK-141
 * provider-agnostic {@link import("./LlmClient").LlmClient} seam.
 *
 * JAK-141 picked ONE provider+model for the whole app from Doppler
 * (LLM_PROVIDER / OPENAI_MODEL / ANTHROPIC_MODEL). JAK-143 lets each editable
 * prompt surface (orchestrator/router, skip-trace, comps, property-report)
 * OPTIONALLY pin its own provider+model, falling back to that same global
 * default when it hasn't. This module owns the pure resolution math — "given the
 * global Doppler default and an optional per-surface override, what concrete
 * {provider, model} do we run?" — so both the factory and the settings service
 * resolve identically.
 *
 * KEYS STILL LIVE IN DOPPLER. This layer only ever SELECTS a provider+model; it
 * never reads, stores, or forwards an API key. Keys stay {@link EnvConfig}
 * secrets (OPENAI_API_KEY / ANTHROPIC_API_KEY), never in the DB and never in a UI.
 */

/** The providers Jake can run against (JAK-141). */
export type LlmProvider = "openai" | "anthropic";

/** The known providers, in UI order. Used by the admin picker + validation. */
export const LLM_PROVIDERS: readonly LlmProvider[] = ["openai", "anthropic"] as const;

/** A fully-resolved provider+model pair — what a client is actually built for. */
export interface LlmSelection {
  provider: LlmProvider;
  model: string;
}

/**
 * A per-surface OVERRIDE of the global default. Either field may be absent/blank,
 * meaning "inherit": a null provider inherits the global provider; a null/blank
 * model inherits that provider's default model.
 */
export interface LlmSelectionOverride {
  provider?: string | null;
  model?: string | null;
}

/**
 * Normalize any stored/config provider string to a known {@link LlmProvider}.
 * Anything that isn't "anthropic" collapses to "openai" — the SAME typo-safe rule
 * the JAK-141 factory uses, so an unknown value can never leave Jake without a
 * model layer.
 */
export function normalizeProvider(raw: string | null | undefined): LlmProvider {
  return (raw ?? "").trim().toLowerCase() === "anthropic" ? "anthropic" : "openai";
}

/** The Doppler default model for a provider (OPENAI_MODEL / ANTHROPIC_MODEL). */
export function defaultModelForProvider(provider: LlmProvider, env: EnvConfig): string {
  return provider === "anthropic" ? env.anthropicModel : env.openAiModel;
}

/**
 * Resolve a concrete {provider, model} from the global Doppler default plus an
 * optional per-surface override. An override's provider wins if given; an
 * override's (trimmed, non-empty) model wins if given, else the resolved
 * provider's default model. With no override this returns the exact JAK-141
 * global default.
 */
export function resolveLlmSelection(
  env: EnvConfig,
  override?: LlmSelectionOverride | null
): LlmSelection {
  const provider = override?.provider
    ? normalizeProvider(override.provider)
    : normalizeProvider(env.llmProvider);
  const model = override?.model?.trim()
    ? override.model.trim()
    : defaultModelForProvider(provider, env);
  return { provider, model };
}

/** The GLOBAL default selection (Doppler LLM_PROVIDER + that provider's model). */
export function globalDefaultSelection(env: EnvConfig): LlmSelection {
  return resolveLlmSelection(env, null);
}

/**
 * Which providers have a key configured in Doppler — booleans ONLY, never the
 * keys themselves. The admin picker uses this to show a subtle "provider key not
 * configured — will use fallback" note without ever exposing or accepting a key.
 */
export function providerKeyConfigured(env: EnvConfig): Record<LlmProvider, boolean> {
  return {
    openai: Boolean(env.openAiApiKey),
    anthropic: Boolean(env.anthropicApiKey),
  };
}
