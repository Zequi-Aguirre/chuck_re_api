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

  describe("per-call selection override (JAK-143)", () => {
    it("with no override, builds the global default provider + model", () => {
      const client = LlmClientFactory.create(env({ llmProvider: "openai" }));
      expect(client.provider).toBe("openai");
      expect(client.model).toBe("gpt-4o");
    });

    it("an override provider selects that provider's client + its default model", () => {
      const client = LlmClientFactory.create(env(), { provider: "anthropic" });
      expect(client.provider).toBe("anthropic");
      expect(client).toBeInstanceOf(AnthropicLlmClient);
      // model unset in the override → the provider's Doppler default.
      expect(client.model).toBe("claude-opus-4-8");
    });

    it("an override model pins the exact model on the resolved provider", () => {
      const client = LlmClientFactory.create(env(), { provider: "openai", model: "gpt-4o-mini" });
      expect(client.provider).toBe("openai");
      expect(client.model).toBe("gpt-4o-mini");
    });

    it("an override model with the global provider pins the model but keeps the global provider", () => {
      const client = LlmClientFactory.create(env({ llmProvider: "anthropic" }), { model: "claude-sonnet-4-6" });
      expect(client.provider).toBe("anthropic");
      expect(client.model).toBe("claude-sonnet-4-6");
    });

    it("a blank override model falls back to the provider's default (no empty model reaches the client)", () => {
      const client = LlmClientFactory.create(env(), { provider: "openai", model: "   " });
      expect(client.model).toBe("gpt-4o");
    });

    it("an unknown override provider is typo-safe → OpenAI + OpenAI's default model", () => {
      const client = LlmClientFactory.create(env(), { provider: "banana", model: "" });
      expect(client.provider).toBe("openai");
      expect(client.model).toBe("gpt-4o");
    });

    it("the key still comes from the SELECTED provider — the model never changes availability", () => {
      // Anthropic selected, model pinned, but no anthropic key → unavailable (clean fallback).
      const noKey = LlmClientFactory.create(env({ anthropicApiKey: "" }), {
        provider: "anthropic",
        model: "claude-sonnet-4-6",
      });
      expect(noKey.isAvailable).toBe(false);
      const withKey = LlmClientFactory.create(env({ anthropicApiKey: "k" }), {
        provider: "anthropic",
        model: "claude-sonnet-4-6",
      });
      expect(withKey.isAvailable).toBe(true);
    });
  });
});
