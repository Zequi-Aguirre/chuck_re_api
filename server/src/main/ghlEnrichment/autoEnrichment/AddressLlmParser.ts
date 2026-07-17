/**
 * LLM address parser for auto-enrichment (JAK-196, epic JAK-180).
 *
 * The deterministic {@link buildAddressParts} recovers a clean street from a dirty
 * line1 whenever it can anchor on a comma or on known structured fields. What it
 * CANNOT crack is the no-comma blob with the structured fields empty —
 * "828 Pearson Oaks Dr collierville TN 38017" — where nothing marks the boundary
 * between the street and the city. That's exactly the shape Eric still saw fail
 * after JAK-195.
 *
 * This parser is the robust fallback, mirroring the Automator AUT-503 ladder:
 *   LLM parse → (the caller's) deterministic heuristic → no_address only if truly
 *   unparseable.
 * It asks the model to split ONE address line into {house, street, city, state,
 * zip}, then re-validates that output through {@link partsFromFields} so the SAME
 * JAK-193 invariants still hold (house number required, bare-zip, state normalized
 * / derived-from-zip). The LLM can never bypass those rules or inject junk.
 *
 * Cost + safety: reuses the provider-agnostic JAK-141 {@link LlmClientResolver}
 * (key in Doppler, never logged). When no key is configured the client's
 * `isAvailable` is false and we return null WITHOUT a call — a clean deterministic
 * degrade, never a spend, never a crash. Any error/timeout/bad-JSON → null too, so
 * the worker simply falls through to `no_address`, never worse than today.
 *
 * Structured HINTS stay authoritative: when the payload carried a real
 * city/state/zip they override whatever the model guessed.
 */
import { inject, injectable } from "tsyringe";
import { LlmClientResolver } from "../../services/llm/LlmClientResolver";
import {
  EnrichmentAddressParts,
  RawAddressFields,
  partsFromFields,
} from "./addressParts";

@injectable()
export class AddressLlmParser {
  private static readonly MAX_TOKENS = 200;

  /** Strict JSON schema the model output MUST satisfy (OpenAI json_schema mode). */
  private static readonly SCHEMA: Record<string, unknown> = {
    type: "object",
    additionalProperties: false,
    properties: {
      house: { type: "string", description: "The leading house/building number only, e.g. '828'." },
      street: { type: "string", description: "Street name WITHOUT the house number, city, state, or zip." },
      city: { type: "string", description: "City/town, or '' if not present." },
      state: { type: "string", description: "2-letter US state code, or '' if not present." },
      zip: { type: "string", description: "5-digit ZIP, or '' if not present." },
    },
    required: ["house", "street", "city", "state", "zip"],
  };

  private static readonly SYSTEM = [
    "You split ONE US mailing address line into its components.",
    "Return ONLY the JSON object the schema describes — no prose.",
    "Rules:",
    "- `house` is the leading building number only (e.g. '828').",
    "- `street` is the street name and type ONLY (e.g. 'Pearson Oaks Dr').",
    "  It MUST NOT contain the city, state, or zip.",
    "- `state` is the 2-letter USPS code (e.g. 'TN'); '' if you cannot tell.",
    "- `zip` is the 5-digit ZIP; '' if absent.",
    "- Use '' for any field the line does not contain. Never invent a value.",
  ].join("\n");

  constructor(
    @inject(LlmClientResolver) private readonly llm: LlmClientResolver
  ) {}

  /**
   * Parse one raw address line into clean structured parts, or null when the LLM
   * is unavailable / errors / returns something that fails the JAK-193 rules.
   * `hints` carries any real structured city/state/zip — authoritative over the
   * model's guess.
   */
  async parse(
    line1: string,
    hints: RawAddressFields = {}
  ): Promise<EnrichmentAddressParts | null> {
    const client = this.llm.resolve();
    if (!client.isAvailable) return null;

    let raw: string;
    try {
      raw = await client.generateStructured({
        system: AddressLlmParser.SYSTEM,
        user: line1,
        maxTokens: AddressLlmParser.MAX_TOKENS,
        schema: AddressLlmParser.SCHEMA,
        schemaName: "address_parse",
      });
    } catch {
      return null; // timeout / network / provider error — clean deterministic degrade.
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null; // non-JSON reply — ignore, fall through to no_address.
    }
    if (!parsed || typeof parsed !== "object") return null;
    const o = parsed as Record<string, unknown>;

    const house = this.str(o.house);
    const street = this.str(o.street);
    if (!house || !street) return null;

    // Re-validate through partsFromFields so the SAME JAK-193 rules apply (house#
    // required, bare-zip, state normalize/derive). Structured hints win over the model.
    return partsFromFields({
      line1: `${house} ${street}`,
      city: this.str(hints.city) ?? this.str(o.city),
      state: this.str(hints.state) ?? this.str(o.state),
      postal: this.str(hints.postal) ?? this.str(o.zip),
    });
  }

  private str(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    const t = value.trim();
    return t.length > 0 ? t : undefined;
  }
}
