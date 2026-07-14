/**
 * JAK-141 — the PROVIDER-AGNOSTIC LLM seam. ONE interface that BOTH the JAK-135
 * orchestrator/router (structured classification) and the JAK-130/136/137
 * specialist writers (free-text SMS) call, so Jake's model layer can be swapped
 * between OpenAI (the DEFAULT — gpt-4o) and Anthropic (Claude) purely from a
 * Doppler env var (LLM_PROVIDER) with NO code change and NO redeploy of new code.
 *
 * Keys live in Doppler (OPENAI_API_KEY / ANTHROPIC_API_KEY) — NEVER in the DB,
 * NEVER in a UI, NEVER hardcoded, and never logged. The two implementations
 * ({@link import("./OpenAiLlmClient").OpenAiLlmClient} and
 * {@link import("./AnthropicLlmClient").AnthropicLlmClient}) are injected behind
 * the {@link LLM_CLIENT} token so tests mock this seam and the suite never hits
 * the network.
 *
 * When the SELECTED provider's key is absent, {@link LlmClient.isAvailable} is
 * false and every caller uses its deterministic fallback instead (router →
 * rule-based classification; specialists → plain-text renderers). So choosing a
 * provider whose key is missing degrades cleanly — it never crashes.
 */

/** A free-text generation request — used by the specialist writers. */
export interface LlmTextRequest {
  /** The fully-composed system prompt (persona + admin STYLE + hard guardrails). */
  system: string;
  /** The user turn (the verified data payload). */
  user: string;
  /** Hard output token cap. */
  maxTokens: number;
  /**
   * Sampling temperature. Honored by providers that accept it (OpenAI Chat
   * Completions); ignored by providers whose current models reject sampling
   * params (Anthropic Opus 4.x returns 400 on `temperature`). Optional so the
   * abstraction stays portable — a writer asks for low variance and each provider
   * applies it the only way it can.
   */
  temperature?: number;
}

/** A structured (JSON-schema-constrained) generation request — used by the router. */
export interface LlmStructuredRequest {
  /** The fully-composed system prompt (persona + admin STYLE + hard rules). */
  system: string;
  /** The user turn (memory context + resolved-address list + the message). */
  user: string;
  /** Hard output token cap. */
  maxTokens: number;
  /** The JSON Schema the output MUST satisfy (identical across providers). */
  schema: Record<string, unknown>;
  /** A short schema name — OpenAI's json_schema format requires one; Anthropic ignores it. */
  schemaName: string;
}

/**
 * The provider-agnostic LLM client the router and specialists depend on. Both
 * capabilities return raw text; the caller owns parsing/validation and the
 * deterministic fallback, so the plan/report shape is identical regardless of
 * which provider produced the tokens.
 */
export interface LlmClient {
  /** Which provider this client talks to ("openai" | "anthropic"). For logs + tests. */
  readonly provider: string;
  /**
   * The exact model this client generates with (JAK-143). Resolved from the
   * per-surface selection or the global default; exposed for logs + tests so a
   * caller can assert the chosen model is honored.
   */
  readonly model: string;
  /** True when a usable API key is configured for this provider (else callers fall back). */
  readonly isAvailable: boolean;
  /** Generate free-form text. Throws on error/timeout/missing key (caller catches → fallback). */
  generateText(req: LlmTextRequest): Promise<string>;
  /** Generate JSON constrained to {@link LlmStructuredRequest.schema}; returns the raw JSON text. */
  generateStructured(req: LlmStructuredRequest): Promise<string>;
}

/** DI token for {@link LlmClient} (interface → needs an explicit token). */
export const LLM_CLIENT = "LlmClient";
