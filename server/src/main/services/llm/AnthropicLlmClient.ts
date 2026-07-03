import Anthropic from "@anthropic-ai/sdk";
import { EnvConfig } from "../../config/envConfig.ts";
import { LlmClient, LlmStructuredRequest, LlmTextRequest } from "./LlmClient.ts";

/**
 * Anthropic (Claude) implementation of {@link LlmClient} (JAK-141) — the OPTIONAL
 * second provider. This wraps the Anthropic SDK usage that previously lived
 * inline in the JAK-135 router, so Claude stays a fully supported choice: set
 * LLM_PROVIDER=anthropic (+ ANTHROPIC_API_KEY) in Doppler and BOTH the router and
 * every specialist run on Claude with no code change.
 *
 * The router's typed plan uses Claude's `output_config.format` json_schema
 * structured output — the SAME schema the OpenAI path uses — so both providers
 * emit the identical plan shape. Adaptive thinking is on for both capabilities;
 * we return only the text block, so no thinking ever leaks into the SMS. Current
 * Opus models reject sampling params, so {@link LlmTextRequest.temperature} is
 * intentionally NOT forwarded here. The API key is an app-level Doppler secret
 * ({@link EnvConfig.anthropicApiKey}) — NEVER hardcoded, never logged; the model
 * is config-driven ({@link EnvConfig.anthropicModel}, default claude-opus-4-8).
 */
export class AnthropicLlmClient implements LlmClient {
  private static readonly TIMEOUT_MS = 8_000;

  readonly provider = "anthropic";

  /** Lazily-built Anthropic client (cached). */
  private anthropic?: Anthropic;

  constructor(private readonly env: EnvConfig) {}

  get isAvailable(): boolean {
    return Boolean(this.env.anthropicApiKey);
  }

  async generateText(req: LlmTextRequest): Promise<string> {
    const response = await this.client().messages.create(
      {
        model: this.env.anthropicModel,
        max_tokens: req.maxTokens,
        thinking: { type: "adaptive" },
        system: req.system,
        messages: [{ role: "user", content: req.user }],
      } as Anthropic.MessageCreateParamsNonStreaming,
      { timeout: AnthropicLlmClient.TIMEOUT_MS }
    );
    return this.firstText(response);
  }

  async generateStructured(req: LlmStructuredRequest): Promise<string> {
    const response = await this.client().messages.create(
      {
        model: this.env.anthropicModel,
        max_tokens: req.maxTokens,
        thinking: { type: "adaptive" },
        system: req.system,
        // Structured output: constrain the reply to the exact schema so the plan
        // shape matches the OpenAI path byte-for-byte after parsing.
        output_config: { format: { type: "json_schema", schema: req.schema } },
        messages: [{ role: "user", content: req.user }],
      } as Anthropic.MessageCreateParamsNonStreaming,
      { timeout: AnthropicLlmClient.TIMEOUT_MS }
    );
    return this.firstText(response);
  }

  /** Pull the first text block out of a Claude response (thinking blocks are skipped). */
  private firstText(response: Anthropic.Message): string {
    const block = response.content.find((b) => b.type === "text");
    return block && block.type === "text" ? block.text : "";
  }

  /** Build (and cache) the Anthropic client. Throws if the key is unset. */
  private client(): Anthropic {
    if (this.anthropic) return this.anthropic;
    if (!this.env.anthropicApiKey) {
      throw new Error("ANTHROPIC_API_KEY is not configured");
    }
    this.anthropic = new Anthropic({
      apiKey: this.env.anthropicApiKey,
      timeout: AnthropicLlmClient.TIMEOUT_MS,
    });
    return this.anthropic;
  }
}
