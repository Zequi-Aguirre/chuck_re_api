/**
 * GHL enrichment module — public surface.
 *
 * The lead-enrichment Marketplace app (see docs/ghl-enrichment/SPEC.md). This
 * barrel keeps the module's imports stable as the internals grow. JAK-101 is
 * scaffolding + config + DI wiring only — no business logic yet.
 */
export { GhlEnrichmentConfig } from "./config/GhlEnrichmentConfig";
export { registerGhlEnrichment } from "./di/registerGhlEnrichment";
