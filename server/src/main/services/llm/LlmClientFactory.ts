import { EnvConfig } from "../../config/envConfig.ts";
import { LlmClient } from "./LlmClient.ts";
import { OpenAiLlmClient } from "./OpenAiLlmClient.ts";
import { AnthropicLlmClient } from "./AnthropicLlmClient.ts";

/**
 * JAK-141 — picks the {@link LlmClient} implementation from Doppler config. The
 * provider is chosen by {@link EnvConfig.llmProvider} (LLM_PROVIDER, default
 * "openai"); an unrecognized value falls back to OpenAI so a typo in Doppler can
 * never leave Jake without a model layer. Keys stay in Doppler — the factory only
 * reads config, it never stores or logs a key.
 *
 * This is intentionally a plain factory (not a DI-decorated class): DI registers
 * the {@link import("./LlmClient").LLM_CLIENT} token to a caching factory that
 * calls this, so the whole app shares ONE client while tests can call
 * {@link create} directly with a hand-built EnvConfig.
 */
export class LlmClientFactory {
  static create(env: EnvConfig): LlmClient {
    switch (env.llmProvider) {
      case "anthropic":
        return new AnthropicLlmClient(env);
      case "openai":
        return new OpenAiLlmClient(env);
      default:
        console.warn(
          `⚠️ LlmClientFactory: unknown LLM_PROVIDER "${env.llmProvider}" — defaulting to openai.`
        );
        return new OpenAiLlmClient(env);
    }
  }
}
