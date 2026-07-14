import { injectable } from "tsyringe";
import { EnvConfig } from "../../config/envConfig";
import { CreditCostConfig } from "../metering/CreditCosts";

/**
 * Module-scoped configuration surface for the GHL enrichment app.
 *
 * Reads everything from the canonical {@link EnvConfig} (Doppler-provided) so
 * the enrichment module has ONE typed place to ask for its settings and never
 * touches `process.env` directly.
 *
 * Scaffolding only (JAK-101) — no business logic. The pieces that consume this
 * (OAuth install, webhook verify, credential store, worker) resolve their
 * settings here rather than reading `process.env` directly.
 */
@injectable()
export class GhlEnrichmentConfig {
  constructor(private readonly env: EnvConfig) {}

  /** GHL Marketplace OAuth app id (post-beta install path, JAK-150). */
  get clientId(): string {
    return this.env.ghlClientId;
  }

  /** GHL Marketplace OAuth app secret (post-beta install path, JAK-150). */
  get clientSecret(): string {
    return this.env.ghlClientSecret;
  }

  /** Shared secret for verifying inbound GHL webhook signatures (JAK-106). */
  get webhookSecret(): string {
    return this.env.ghlWebhookSecret;
  }

  /**
   * App-level key used to encrypt per-location connection credentials at rest
   * (JAK-102 / JAK-113). Only the key lives in Doppler — never a tenant's own
   * API key, which is stored encrypted in the DB.
   */
  get credentialEncryptionKey(): string {
    return this.env.ghlCredentialEncKey;
  }

  /**
   * Text-Jake MASTER GATEWAY credentials (JAK-115) — the single Zequi-owned Jake
   * sub-account used for tier-1 / trial texting (text_mode='gateway'). These are
   * app-level Doppler secrets, NEVER stored in the DB and NEVER per-tenant. Empty
   * strings when unset; {@link import("../gateway/JakeGatewayClient").JakeGatewayClient}
   * refuses to send if used unconfigured.
   */
  get gateway(): { apiKey: string; locationId: string; baseUrl: string; fromNumber: string } {
    return {
      apiKey: this.env.jakeGatewayGhlApiKey,
      locationId: this.env.jakeGatewayLocationId,
      baseUrl: this.env.jakeGatewayBaseUrl,
      // Configured DEFAULT reply-from number (JAK-force-fromnumber-833). Empty when
      // unset → the gateway send path omits fromNumber and GHL uses the sub-account
      // default, exactly as before.
      fromNumber: this.env.jakeGatewayFromNumber,
    };
  }

  /**
   * Per-operation credit costs (JAK-109). Config-driven so the enrichment
   * economics can be tuned per environment without a code change. Not secrets —
   * tunable pricing constants with safe defaults resolved in {@link EnvConfig}.
   */
  get creditCosts(): CreditCostConfig {
    return {
      enrichmentBaseCredits: this.env.creditCostEnrichment,
      skipTraceCredits: this.env.creditCostSkipTrace,
      textLookupCredits: this.env.creditCostTextLookup,
    };
  }

  // Env-stage passthrough. The dev/staging write-safety rule (SPEC §8 — never
  // write to a real GHL sub-account off prod) reads these; they resolve to the
  // single canonical helper on EnvConfig.
  get isProduction(): boolean {
    return this.env.isProduction;
  }

  get isStaging(): boolean {
    return this.env.isStaging;
  }

  get isDev(): boolean {
    return this.env.isDev;
  }
}
