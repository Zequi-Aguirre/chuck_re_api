import { EnvConfig } from "../../config/envConfig.ts";
import { LlmClient } from "./LlmClient.ts";
import { OpenAiLlmClient } from "./OpenAiLlmClient.ts";
import { AnthropicLlmClient } from "./AnthropicLlmClient.ts";
import { LlmSelectionOverride, resolveLlmSelection } from "./LlmSelection.ts";

/**
 * JAK-141 — picks the {@link LlmClient} implementation from Doppler config. The
 * provider is chosen by {@link EnvConfig.llmProvider} (LLM_PROVIDER, default
 * "openai"); an unrecognized value falls back to OpenAI so a typo in Doppler can
 * never leave Jake without a model layer. Keys stay in Doppler — the factory only
 * reads config, it never stores or logs a key.
 *
 * JAK-143 — the factory now also accepts an OPTIONAL per-call selection override
 * so a prompt surface can pin its own provider+model. With no override it builds
 * the exact JAK-141 global default; with one it builds a client for the resolved
 * {provider, model} (gaps still fall back to the Doppler default). The model is
 * the only thing that changes — the key stays the same Doppler secret.
 *
 * This is intentionally a plain factory (not a DI-decorated class): DI registers
 * the {@link import("./LlmClient").LLM_CLIENT} token to a caching factory that
 * calls this, and {@link import("./LlmClientResolver").LlmClientResolver} calls it
 * per selection, while tests call {@link create} directly with a hand-built
 * EnvConfig.
 */
export class LlmClientFactory {
  static create(env: EnvConfig, override?: LlmSelectionOverride | null): LlmClient {
    const { provider, model } = resolveLlmSelection(env, override);
    switch (provider) {
      case "anthropic":
        return new AnthropicLlmClient(env, model);
      case "openai":
      default:
        // resolveLlmSelection already collapses any unknown provider to "openai",
        // so this branch is the normal OpenAI path (and the typo-safe default).
        return new OpenAiLlmClient(env, model);
    }
  }
}
