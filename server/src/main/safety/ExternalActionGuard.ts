import { injectable } from "tsyringe";
import { EnvConfig } from "../config/envConfig";

/**
 * The single dev-safety boundary for the whole app (SPEC §8 / JAK-110).
 *
 * "Real, costly, or customer-visible external actions" — GHL writes
 * (custom-field updates, notes, tags, custom-field provisioning), outbound SMS,
 * and paid RealEstate API lookups — must NEVER fire from dev. They fire only in
 * production and staging (staging points at a dedicated test sub-account, never
 * a customer's). This class is the ONE place that decision lives, so no caller
 * re-derives the environment and no per-call guard can drift out of sync.
 *
 * This is deliberately an ENV GATE, not a runtime mock/live toggle: writes and
 * outbound are never switchable on in dev. (Read-only APIs may add a mock/live
 * toggle elsewhere; this gate does not.) It reads the single canonical env
 * source ({@link EnvConfig} `isProduction`/`isStaging`), so flipping the stage —
 * and nothing else — is what turns real actions on.
 *
 * Every transport that can reach a real customer system funnels its guard check
 * and its skip-echo through this object:
 *  - {@link import("../ghlEnrichment/api/GhlApiClient").GhlApiClient} (canonical
 *    multi-tenant client, JAK-104) — gated at its request chokepoint by verb.
 *  - {@link import("../data/GhlApiDao").GhlApiDao} (parked MVP client) — gated at
 *    its outbound chokepoint (writes/tags/SMS).
 *  - {@link import("../data/RealEstateApiDao").RealEstateApiDao} — gated at its
 *    paid-lookup chokepoint (no PropertySearch/PropertyDetail spend off prod).
 */
@injectable()
export class ExternalActionGuard {
  constructor(private readonly env: EnvConfig) {}

  /**
   * True only when real external actions may execute — i.e. in production or
   * staging. Dev is ALWAYS false. This is the single predicate the whole app
   * gates writes/outbound/paid-lookups on.
   */
  get liveActionsAllowed(): boolean {
    return this.env.isProduction || this.env.isStaging;
  }

  /**
   * The single echo sink (SPEC §8). When an external action is suppressed in
   * dev, transports call this so there's exactly one place — and one format —
   * that records what WOULD have happened. `detail` must be secret-free (no
   * tokens, no PII); callers pass a short operation description, never a body.
   */
  echoSkipped(action: string, detail: string): void {
    console.log(
      `🧪 [dev safety] skipped ${action}: ${detail} — no real external call off prod/staging`
    );
  }
}
