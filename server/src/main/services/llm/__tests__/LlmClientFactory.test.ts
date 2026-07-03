import { LlmClientFactory } from "../LlmClientFactory";
import { OpenAiLlmClient } from "../OpenAiLlmClient";
import { AnthropicLlmClient } from "../AnthropicLlmClient";
import { EnvConfig } from "../../../config/envConfig";

/**
 * JAK-141 — the provider factory picks the LlmClient from Doppler config, defaults
 * to OpenAI, and never touches the network (construction is lazy; provider +
 * isAvailable are pure reads). Selecting a provider whose key is missing yields a
 * client that reports isAvailable=false so callers fall back cleanly.
 */
const env = (over: Partial<EnvConfig> = {}): EnvConfig =>
  ({
    llmProvider: "openai",
    openAiApiKey: "",
    anthropicApiKey: "",
    openAiModel: "gpt-4o",
    anthropicModel: "claude-opus-4-8",
    ...over,
  } as unknown as EnvConfig);

describe("LlmClientFactory (JAK-141)", () => {
  it("defaults to OpenAI", () => {
    const client = LlmClientFactory.create(env());
    expect(client.provider).toBe("openai");
    expect(client).toBeInstanceOf(OpenAiLlmClient);
  });

  it("selects Anthropic when LLM_PROVIDER=anthropic", () => {
    const client = LlmClientFactory.create(env({ llmProvider: "anthropic" }));
    expect(client.provider).toBe("anthropic");
    expect(client).toBeInstanceOf(AnthropicLlmClient);
  });

  it("falls back to OpenAI on an unknown provider (typo-safe)", () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const client = LlmClientFactory.create(env({ llmProvider: "banana" }));
    expect(client.provider).toBe("openai");
    expect(client).toBeInstanceOf(OpenAiLlmClient);
    warn.mockRestore();
  });

  it("isAvailable reflects the SELECTED provider's key (missing key → clean fallback)", () => {
    expect(LlmClientFactory.create(env({ llmProvider: "openai", openAiApiKey: "k" })).isAvailable).toBe(true);
    expect(LlmClientFactory.create(env({ llmProvider: "openai", openAiApiKey: "" })).isAvailable).toBe(false);
    expect(LlmClientFactory.create(env({ llmProvider: "anthropic", anthropicApiKey: "k" })).isAvailable).toBe(true);
    expect(LlmClientFactory.create(env({ llmProvider: "anthropic", anthropicApiKey: "" })).isAvailable).toBe(false);
  });
});
