import { DependencyContainer } from "tsyringe";
import { GhlEnrichmentConfig } from "../config/GhlEnrichmentConfig";
import { GhlApiDao } from "../../data/GhlApiDao";

/**
 * DI registration for the GHL enrichment module.
 *
 * tsyringe auto-resolves @injectable classes, so this is the module's single
 * explicit wiring point: it makes shared singletons obvious and gives later
 * tickets one function to hang new registrations on (credential store, OAuth
 * service, webhook verifier, field mapping…).
 *
 * It EXTENDS the existing MVP scaffolding (GhlApiDao, the parked Redis
 * enrichment worker, /api/ghl) — it does not duplicate it.
 */
export const registerGhlEnrichment = (c: DependencyContainer): void => {
  if (!c.isRegistered(GhlEnrichmentConfig)) {
    c.registerSingleton(GhlEnrichmentConfig);
  }

  // GhlApiDao already ships from the MVP; keep a single shared instance so the
  // enrichment module and the existing SMS/webhook paths reuse one client.
  if (!c.isRegistered(GhlApiDao)) {
    c.registerSingleton(GhlApiDao);
  }
};
