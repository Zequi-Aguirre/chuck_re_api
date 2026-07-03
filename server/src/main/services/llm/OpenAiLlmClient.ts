import OpenAI from "openai";
import { EnvConfig } from "../../config/envConfig.ts";
import { LlmClient, LlmStructuredRequest, LlmTextRequest } from "./LlmClient.ts";

/**
 * OpenAI implementation of {@link LlmClient} (JAK-141) — Jake's DEFAULT provider.
 *
 * Text (specialist writers) goes through Chat Completions; the router's typed
 * plan uses the `json_schema` structured-output response format (strict), so
 * OpenAI returns the SAME schema-constrained JSON the Anthropic path returns and
 * the router's parser sees an identical shape. The API key is an app-level
 * Doppler secret ({@link EnvConfig.openAiApiKey}) — NEVER hardcoded, never logged;
 * the model is config-driven ({@link EnvConfig.openAiModel}, default gpt-4o) so it
 * can change without a redeploy.
 *
 * The client is built lazily and only when a key is present; {@link isAvailable}
 * lets callers skip the call entirely when the key is unset, so a missing key is
 * a clean fallback rather than a thrown error mid-request.
 */
export class OpenAiLlmClient implements LlmClient {
  private static readonly TIMEOUT_MS = 8_000;

  readonly provider = "openai";

  /** Lazily-built OpenAI client (cached). */
  private openai?: OpenAI;

  constructor(private readonly env: EnvConfig) {}

  get isAvailable(): boolean {
    return Boolean(this.env.openAiApiKey);
  }

  async generateText(req: LlmTextRequest): Promise<string> {
    const completion = await this.client().chat.completions.create(
      {
        model: this.env.openAiModel,
        temperature: req.temperature,
        max_tokens: req.maxTokens,
        messages: [
          { role: "system", content: req.system },
          { role: "user", content: req.user },
        ],
      },
      { timeout: OpenAiLlmClient.TIMEOUT_MS }
    );
    return completion.choices?.[0]?.message?.content ?? "";
  }

  async generateStructured(req: LlmStructuredRequest): Promise<string> {
    const completion = await this.client().chat.completions.create(
      {
        model: this.env.openAiModel,
        max_tokens: req.maxTokens,
        // Structured output: constrain the reply to the exact schema so the plan
        // shape matches the Anthropic path byte-for-byte after parsing.
        response_format: {
          type: "json_schema",
          json_schema: { name: req.schemaName, schema: req.schema, strict: true },
        },
        messages: [
          { role: "system", content: req.system },
          { role: "user", content: req.user },
        ],
      },
      { timeout: OpenAiLlmClient.TIMEOUT_MS }
    );
    return completion.choices?.[0]?.message?.content ?? "";
  }

  /** Build (and cache) the OpenAI client. Throws if the key is unset. */
  private client(): OpenAI {
    if (this.openai) return this.openai;
    if (!this.env.openAiApiKey) {
      throw new Error("OPENAI_API_KEY is not configured");
    }
    this.openai = new OpenAI({
      apiKey: this.env.openAiApiKey,
      timeout: OpenAiLlmClient.TIMEOUT_MS,
    });
    return this.openai;
  }
}
