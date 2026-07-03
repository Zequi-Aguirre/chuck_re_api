import { injectable } from "tsyringe";
import { EnvConfig } from "../../config/envConfig.ts";
import { LlmClient } from "./LlmClient.ts";
import { LlmClientFactory } from "./LlmClientFactory.ts";
import {
  LlmSelection,
  LlmSelectionOverride,
  resolveLlmSelection,
} from "./LlmSelection.ts";

/**
 * JAK-143 — resolves a concrete {@link LlmClient} for a per-call provider+model
 * selection, so the router and each specialist writer can honor their own
 * per-surface setting instead of the one app-wide client JAK-141 registered.
 *
 * It memoizes one client per distinct {provider, model} pair (the underlying SDK
 * client is built lazily inside each {@link LlmClient} on first use), so repeated
 * calls with the same selection reuse the same instance — the same "one client
 * per config" spirit as the JAK-141 caching factory, just keyed by selection
 * instead of a single global.
 *
 * KEYS STAY IN DOPPLER. The resolver only ever selects a provider+model; the key
 * lives inside the built client, sourced from {@link EnvConfig}. It never reads,
 * stores, or logs a key, and adds no key entry anywhere.
 */
@injectable()
export class LlmClientResolver {
  /** provider|model -> the built client for that selection. */
  private readonly cache = new Map<string, LlmClient>();

  constructor(private readonly env: EnvConfig) {}

  /**
   * The concrete client for a selection. A null/blank override resolves to the
   * JAK-141 global default; gaps in an override (missing provider or model) fall
   * back to the Doppler default.
   */
  resolve(override?: LlmSelectionOverride | null): LlmClient {
    const selection = resolveLlmSelection(this.env, override);
    const key = `${selection.provider}|${selection.model}`;
    let client = this.cache.get(key);
    if (!client) {
      client = LlmClientFactory.create(this.env, selection);
      this.cache.set(key, client);
    }
    return client;
  }

  /** The resolved {provider, model} for a selection — pure, no client built. */
  effectiveSelection(override?: LlmSelectionOverride | null): LlmSelection {
    return resolveLlmSelection(this.env, override);
  }
}
