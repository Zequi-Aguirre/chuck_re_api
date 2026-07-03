import { LlmClientResolver } from "../LlmClientResolver";
import { OpenAiLlmClient } from "../OpenAiLlmClient";
import { AnthropicLlmClient } from "../AnthropicLlmClient";
import { EnvConfig } from "../../../config/envConfig";

/**
 * JAK-143 — the resolver turns a per-surface {provider, model} selection into a
 * concrete LlmClient, falling back to the JAK-141 global default, and memoizes one
 * client per distinct selection. Construction is lazy (no network), so these run
 * offline. Keys are never read here — they live inside the built client.
 */
const env = (over: Partial<EnvConfig> = {}): EnvConfig =>
  ({
    llmProvider: "openai",
    openAiApiKey: "openai-key",
    anthropicApiKey: "anthropic-key",
    openAiModel: "gpt-4o",
    anthropicModel: "claude-opus-4-8",
    ...over,
  } as unknown as EnvConfig);

describe("LlmClientResolver (JAK-143)", () => {
  it("no override → the global default provider + model", () => {
    const client = new LlmClientResolver(env({ llmProvider: "openai" })).resolve();
    expect(client.provider).toBe("openai");
    expect(client.model).toBe("gpt-4o");
    expect(client).toBeInstanceOf(OpenAiLlmClient);
  });

  it("resolves the selected provider + model", () => {
    const client = new LlmClientResolver(env()).resolve({ provider: "anthropic", model: "claude-sonnet-4-6" });
    expect(client.provider).toBe("anthropic");
    expect(client.model).toBe("claude-sonnet-4-6");
    expect(client).toBeInstanceOf(AnthropicLlmClient);
  });

  it("memoizes one client per selection (same selection → same instance)", () => {
    const resolver = new LlmClientResolver(env());
    const a = resolver.resolve({ provider: "openai", model: "gpt-4o-mini" });
    const b = resolver.resolve({ provider: "openai", model: "gpt-4o-mini" });
    expect(a).toBe(b);
  });

  it("different selections get different clients", () => {
    const resolver = new LlmClientResolver(env());
    const mini = resolver.resolve({ provider: "openai", model: "gpt-4o-mini" });
    const full = resolver.resolve({ provider: "openai", model: "gpt-4o" });
    const claude = resolver.resolve({ provider: "anthropic", model: "claude-sonnet-4-6" });
    expect(mini).not.toBe(full);
    expect(full).not.toBe(claude);
    expect(mini.model).toBe("gpt-4o-mini");
    expect(claude.provider).toBe("anthropic");
  });

  it("effectiveSelection resolves without building a client", () => {
    const resolver = new LlmClientResolver(env({ llmProvider: "anthropic", anthropicModel: "claude-opus-4-8" }));
    expect(resolver.effectiveSelection()).toEqual({ provider: "anthropic", model: "claude-opus-4-8" });
    expect(resolver.effectiveSelection({ provider: "openai", model: "gpt-4o-mini" })).toEqual({
      provider: "openai",
      model: "gpt-4o-mini",
    });
  });

  it("availability tracks the SELECTED provider's key — the model never changes it", () => {
    const resolver = new LlmClientResolver(env({ openAiApiKey: "k", anthropicApiKey: "" }));
    expect(resolver.resolve({ provider: "openai", model: "gpt-4o-mini" }).isAvailable).toBe(true);
    expect(resolver.resolve({ provider: "anthropic", model: "claude-sonnet-4-6" }).isAvailable).toBe(false);
  });
});
