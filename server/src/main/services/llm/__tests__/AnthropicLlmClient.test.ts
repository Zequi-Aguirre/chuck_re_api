const mockMessagesCreate = jest.fn();

// Mock the Anthropic SDK so no network call is made — the constructor returns a
// fake whose messages.create we control.
jest.mock("@anthropic-ai/sdk", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    messages: { create: mockMessagesCreate },
  })),
}));

import { AnthropicLlmClient } from "../AnthropicLlmClient";
import { EnvConfig } from "../../../config/envConfig";

/**
 * JAK-141 — the Anthropic (Claude) implementation of the LlmClient seam (the
 * OPTIONAL provider) must keep working. Verifies, with the SDK mocked (no network):
 * (a) the router's typed plan uses Claude's output_config json_schema structured
 * output + adaptive thinking and returns the text block, (b) text generation runs
 * WITHOUT a sampling temperature (current Opus models reject it), and (c) a missing
 * key throws so the caller falls back deterministically.
 */
const env = (over: Partial<EnvConfig> = {}): EnvConfig =>
  ({ anthropicApiKey: "test-key", anthropicModel: "claude-opus-4-8", ...over } as unknown as EnvConfig);

/** A Claude message shape carrying a single text block. */
const textResponse = (text: string) => ({ content: [{ type: "text", text }] });

describe("AnthropicLlmClient (JAK-141, optional provider)", () => {
  beforeEach(() => mockMessagesCreate.mockReset());

  it("reports isAvailable from the key", () => {
    expect(new AnthropicLlmClient(env()).isAvailable).toBe(true);
    expect(new AnthropicLlmClient(env({ anthropicApiKey: "" })).isAvailable).toBe(false);
    expect(new AnthropicLlmClient(env()).provider).toBe("anthropic");
  });

  it("generateStructured uses output_config json_schema + adaptive thinking and returns the plan text", async () => {
    const plan = JSON.stringify({ intent: "skip_trace", targetAddress: null });
    mockMessagesCreate.mockResolvedValue(textResponse(plan));
    const schema = { type: "object", additionalProperties: false } as Record<string, unknown>;

    const out = await new AnthropicLlmClient(env()).generateStructured({
      system: "SYS",
      user: "USR",
      maxTokens: 100,
      schema,
      schemaName: "router_classification",
    });

    expect(out).toBe(plan);
    const [params] = mockMessagesCreate.mock.calls[0]!;
    expect(params.model).toBe("claude-opus-4-8");
    expect(params.thinking).toEqual({ type: "adaptive" });
    expect(params.output_config).toEqual({ format: { type: "json_schema", schema } });
    expect(params.system).toBe("SYS");
    expect(params.messages).toEqual([{ role: "user", content: "USR" }]);
  });

  it("generateText returns the text block and does NOT send a sampling temperature", async () => {
    mockMessagesCreate.mockResolvedValue(textResponse("hi there"));

    const out = await new AnthropicLlmClient(env()).generateText({
      system: "SYS",
      user: "USR",
      maxTokens: 50,
      temperature: 0.2,
    });

    expect(out).toBe("hi there");
    const [params] = mockMessagesCreate.mock.calls[0]!;
    expect(params.temperature).toBeUndefined();
    expect(params.thinking).toEqual({ type: "adaptive" });
    expect(params.max_tokens).toBe(50);
  });

  it("throws (→ caller fallback) when the key is unset — no client is built", async () => {
    await expect(
      new AnthropicLlmClient(env({ anthropicApiKey: "" })).generateText({ system: "S", user: "U", maxTokens: 10 })
    ).rejects.toThrow(/ANTHROPIC_API_KEY/);
    expect(mockMessagesCreate).not.toHaveBeenCalled();
  });
});
