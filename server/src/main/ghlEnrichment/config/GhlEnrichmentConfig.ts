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
 * (OAuth install, webhook verify, credential store, worker) land in later
 * tickets and build on the parked MVP scaffolding (GhlApiDao, the Redis
 * enrichment worker, /api/ghl) rather than duplicating it.
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

  /** Base URL for GHL API calls. */
  get apiBaseUrl(): string {
    return this.env.ghlBaseUrl;
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
