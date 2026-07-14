const mockCreate = jest.fn();

// Mock the OpenAI SDK so no network call is made — the constructor returns a fake
// whose chat.completions.create we control.
jest.mock("openai", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    chat: { completions: { create: mockCreate } },
  })),
}));

import { OpenAiLlmClient } from "../OpenAiLlmClient";
import { EnvConfig } from "../../../config/envConfig";

/**
 * JAK-141 — the OpenAI implementation of the LlmClient seam (Jake's DEFAULT
 * provider). Verifies, with the SDK mocked (no network): (a) the router's typed
 * plan uses json_schema STRUCTURED output and comes back verbatim, (b) text
 * generation forwards temperature + model, and (c) a missing key throws so the
 * caller falls back deterministically.
 */
const env = (over: Partial<EnvConfig> = {}): EnvConfig =>
  ({ openAiApiKey: "test-key", openAiModel: "gpt-4o", ...over } as unknown as EnvConfig);

describe("OpenAiLlmClient (JAK-141, default provider)", () => {
  beforeEach(() => mockCreate.mockReset());

  it("reports isAvailable from the key", () => {
    expect(new OpenAiLlmClient(env()).isAvailable).toBe(true);
    expect(new OpenAiLlmClient(env({ openAiApiKey: "" })).isAvailable).toBe(false);
    expect(new OpenAiLlmClient(env()).provider).toBe("openai");
  });

  it("generateStructured requests json_schema structured output and returns the plan JSON", async () => {
    const plan = JSON.stringify({ intent: "comps", targetAddress: null });
    mockCreate.mockResolvedValue({ choices: [{ message: { content: plan } }] });
    const schema = { type: "object", additionalProperties: false } as Record<string, unknown>;

    const out = await new OpenAiLlmClient(env()).generateStructured({
      system: "SYS",
      user: "USR",
      maxTokens: 100,
      schema,
      schemaName: "router_classification",
    });

    expect(out).toBe(plan);
    const [params] = mockCreate.mock.calls[0]!;
    expect(params.model).toBe("gpt-4o");
    expect(params.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "router_classification", schema, strict: true },
    });
    expect(params.messages).toEqual([
      { role: "system", content: "SYS" },
      { role: "user", content: "USR" },
    ]);
  });

  it("generateText forwards the model + temperature and returns the content", async () => {
    mockCreate.mockResolvedValue({ choices: [{ message: { content: "hello" } }] });

    const out = await new OpenAiLlmClient(env()).generateText({
      system: "SYS",
      user: "USR",
      maxTokens: 50,
      temperature: 0.2,
    });

    expect(out).toBe("hello");
    const [params] = mockCreate.mock.calls[0]!;
    expect(params.model).toBe("gpt-4o");
    expect(params.temperature).toBe(0.2);
    expect(params.max_tokens).toBe(50);
  });

  it("throws (→ caller fallback) when the key is unset — no client is built", async () => {
    await expect(
      new OpenAiLlmClient(env({ openAiApiKey: "" })).generateText({ system: "S", user: "U", maxTokens: 10 })
    ).rejects.toThrow(/OPENAI_API_KEY/);
    expect(mockCreate).not.toHaveBeenCalled();
  });
});
