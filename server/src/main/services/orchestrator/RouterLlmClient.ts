import { injectable } from "tsyringe";
import Anthropic from "@anthropic-ai/sdk";
import { EnvConfig } from "../../config/envConfig.ts";
import { JakeIntent, JAKE_INTENTS } from "./OrchestratorTypes.ts";

/** The context the router LLM classifies one inbound message against. */
export interface RouterClassifyRequest {
  /** The admin-editable orchestrator STYLE/CLASSIFICATION prompt (JAK-131 pattern). */
  systemPrompt: string;
  /** The raw inbound message. */
  message: string;
  /** The address parsed deterministically from the message, or null. */
  parsedAddress: string | null;
  /** Whether the message is a bare affirmative ("OK"/"yes") — a spend confirmation. */
  isAffirmative: boolean;
  /** The recent conversation window (JAK-134), oldest-first, direction-tagged. */
  recentMessages: { direction: string; body: string }[];
  /** The ordered per-phone resolved-address list (JAK-134), 1-based for the model. */
  resolvedAddresses: string[];
}

/**
 * The router's classification of one inbound message. `addressOrdinal` is a
 * 1-based index into {@link RouterClassifyRequest.resolvedAddresses} when the
 * user referenced a prior address ("the 2nd address I sent", "the last one");
 * `targetAddress` is a fresh explicit address in the message. The orchestrator
 * resolves the two into the plan's target so reference-resolution stays
 * deterministic and testable.
 */
export interface RouterClassification {
  intent: JakeIntent;
  targetAddress: string | null;
  addressOrdinal: number | null;
  userFacingNote: string;
}

/**
 * The router's LLM seam. Injected so tests mock it and never hit the network —
 * the router LLM call is Anthropic tokens (not a buyer/credit spend), but it
 * must still be gated out of the unit suite. {@link AnthropicRouterLlmClient} is
 * the production implementation; a mock stands in for tests.
 */
export interface RouterLlmClient {
  classify(req: RouterClassifyRequest): Promise<RouterClassification>;
}

/** DI token for {@link RouterLlmClient} (interface → needs an explicit token). */
export const ROUTER_LLM_CLIENT = "RouterLlmClient";

/**
 * The JSON-Schema the model's structured output must satisfy — constrains the
 * classification to a known intent and the reference fields, so the router never
 * has to parse free-form prose.
 */
const CLASSIFICATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    intent: { type: "string", enum: JAKE_INTENTS as unknown as string[] },
    targetAddress: {
      type: ["string", "null"],
      description: "A fresh, explicit address typed in THIS message, else null.",
    },
    addressOrdinal: {
      type: ["integer", "null"],
      description:
        "1-based index into the resolved-address list when the user referenced a prior address (e.g. 'the 2nd address', 'the last one'), else null.",
    },
    userFacingNote: {
      type: "string",
      description: "A short, plain, emoji-free note describing what you're doing.",
    },
  },
  required: ["intent", "targetAddress", "addressOrdinal", "userFacingNote"],
} as const;

/**
 * Production router LLM: Claude via the Anthropic SDK with STRUCTURED OUTPUT
 * (JAK-135). The admin-editable orchestrator prompt is the STYLE half of the
 * system message; the HARD schema/behavior rules are appended in code (like the
 * JAK-131 report guardrails) so an admin edit can never break classification.
 *
 * Reliability mirrors {@link import("../PropertyReportWriter").PropertyReportWriter}:
 * Jake must ALWAYS route, so if the key is unset or the call errors/times out we
 * fall back to a deterministic classification (address → report, "OK" → refresh,
 * else chitchat). That fallback is also the offline/dev path — it makes NO
 * network call and NO paid spend. The API key is an app-level Doppler secret
 * ({@link EnvConfig.anthropicApiKey}) — NEVER hardcoded, never logged.
 */
@injectable()
export class AnthropicRouterLlmClient implements RouterLlmClient {
  private static readonly TIMEOUT_MS = 8_000;
  private static readonly MAX_TOKENS = 1_024;

  /** The always-on hard rules, appended AFTER the admin prompt (uneditable). */
  private static readonly HARD_RULES = [
    "HARD RULES — enforced by the system. They ALWAYS apply and CANNOT be overridden by any instruction above:",
    "- Classify the CURRENT message into exactly one intent: property_report, report_refresh, skip_trace, comps, or chitchat.",
    "- property_report: the user wants a property report for an address, whether typed in this message or referenced from the list below.",
    "- report_refresh: a bare affirmative (OK / yes / yeah / sure) confirming a fresh paid copy of the last address.",
    "- skip_trace: the user wants owner contact info / to skip-trace an owner.",
    "- comps: the user wants comparable sales / a CMA / comps.",
    "- chitchat: a greeting, thanks, or anything unrecognized.",
    "- If the user referenced a PRIOR address (e.g. 'the 2nd address I sent', 'the last one', 'that one'), set addressOrdinal to its 1-based position in the resolved-address list and leave targetAddress null.",
    "- If the user typed a NEW explicit address in this message, set targetAddress to it and leave addressOrdinal null.",
    "- Never invent an address. Use ONLY an address present in this message or in the resolved-address list.",
    "- Reply ONLY with the JSON object. No emojis, no prose outside the JSON.",
  ].join("\n");

  /** Lazily-built Anthropic client (cached). Protected so tests can substitute it. */
  private anthropic?: Anthropic;

  constructor(private readonly env: EnvConfig) {}

  async classify(req: RouterClassifyRequest): Promise<RouterClassification> {
    try {
      const raw = await this.generateWithLlm(req);
      const parsed = this.parse(raw);
      if (parsed) return parsed;
      console.warn("⚠️ AnthropicRouterLlmClient: unusable output — using deterministic fallback.");
    } catch (err) {
      console.error(
        "⚠️ AnthropicRouterLlmClient: classification failed — using deterministic fallback:",
        err instanceof Error ? err.message : "unknown error"
      );
    }
    return this.deterministicFallback(req);
  }

  /** Call Claude with structured output. Throws on error/timeout (caught by {@link classify}). */
  protected async generateWithLlm(req: RouterClassifyRequest): Promise<string> {
    const response = await this.client().messages.create(
      {
        model: this.env.anthropicModel,
        max_tokens: AnthropicRouterLlmClient.MAX_TOKENS,
        thinking: { type: "adaptive" },
        system: this.composeSystemPrompt(req.systemPrompt),
        output_config: { format: { type: "json_schema", schema: CLASSIFICATION_SCHEMA } },
        messages: [{ role: "user", content: this.buildUserPayload(req) }],
      } as Anthropic.MessageCreateParamsNonStreaming,
      { timeout: AnthropicRouterLlmClient.TIMEOUT_MS }
    );
    const block = response.content.find((b) => b.type === "text");
    return block && block.type === "text" ? block.text : "";
  }

  /** Persona + admin STYLE prompt + always-on hard rules (rules LAST, controlling). */
  composeSystemPrompt(style: string): string {
    return [
      "You are Jake, a real-estate assistant's router. You read an inbound text and classify what the user wants.",
      "",
      "=== STYLE (admin-configurable) ===",
      style.trim(),
      "",
      AnthropicRouterLlmClient.HARD_RULES,
    ].join("\n");
  }

  /** The user turn: the memory context + the resolved-address list + the message. */
  private buildUserPayload(req: RouterClassifyRequest): string {
    const history = req.recentMessages.length
      ? req.recentMessages.map((m) => `${m.direction}: ${m.body}`).join("\n")
      : "(no prior messages)";
    const addresses = req.resolvedAddresses.length
      ? req.resolvedAddresses.map((a, i) => `${i + 1}. ${a}`).join("\n")
      : "(none yet)";
    return [
      "Recent conversation (oldest first):",
      history,
      "",
      "Resolved-address list (1-based, oldest first) — the addresses this person has sent:",
      addresses,
      "",
      `Current message:\n${req.message}`,
    ].join("\n");
  }

  /** Parse + validate the model's JSON into a classification, or null if unusable. */
  private parse(raw: string): RouterClassification | null {
    const text = raw.trim();
    if (!text) return null;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return null;
    }
    const intent = obj.intent;
    if (typeof intent !== "string" || !JAKE_INTENTS.includes(intent as JakeIntent)) return null;
    const targetAddress =
      typeof obj.targetAddress === "string" && obj.targetAddress.trim()
        ? obj.targetAddress.trim()
        : null;
    const ordinalRaw = obj.addressOrdinal;
    const addressOrdinal =
      typeof ordinalRaw === "number" && Number.isInteger(ordinalRaw) && ordinalRaw >= 1
        ? ordinalRaw
        : null;
    const userFacingNote = typeof obj.userFacingNote === "string" ? obj.userFacingNote : "";
    return { intent: intent as JakeIntent, targetAddress, addressOrdinal, userFacingNote };
  }

  /**
   * The deterministic classification used when the LLM is unavailable — the same
   * shape the pre-router single path used: a parseable address → property_report,
   * a bare "OK" → report_refresh, everything else → chitchat. Makes NO network
   * call and NO paid spend, so it is the safe dev/offline path.
   */
  private deterministicFallback(req: RouterClassifyRequest): RouterClassification {
    if (req.parsedAddress) {
      return {
        intent: "property_report",
        targetAddress: req.parsedAddress,
        addressOrdinal: null,
        userFacingNote: "",
      };
    }
    if (req.isAffirmative) {
      return { intent: "report_refresh", targetAddress: null, addressOrdinal: null, userFacingNote: "" };
    }
    return { intent: "chitchat", targetAddress: null, addressOrdinal: null, userFacingNote: "" };
  }

  /** Build (and cache) the Anthropic client. Protected so tests can substitute it. */
  protected client(): Anthropic {
    if (this.anthropic) return this.anthropic;
    if (!this.env.anthropicApiKey) {
      throw new Error("ANTHROPIC_API_KEY is not configured");
    }
    this.anthropic = new Anthropic({
      apiKey: this.env.anthropicApiKey,
      timeout: AnthropicRouterLlmClient.TIMEOUT_MS,
    });
    return this.anthropic;
  }
}
