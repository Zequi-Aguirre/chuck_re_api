/**
 * GHL enrichment module — public surface.
 *
 * The lead-enrichment Marketplace app (see docs/ghl-enrichment/SPEC.md). This
 * barrel keeps the module's imports stable as the internals grow.
 */
export { GhlEnrichmentConfig } from "./config/GhlEnrichmentConfig";
export { registerGhlEnrichment } from "./di/registerGhlEnrichment";

// JAK-102 — encrypted per-location connection/credential store.
export { GhlConnectionService } from "./connections/GhlConnectionService";
export { CredentialCipher } from "./connections/CredentialCipher";
export { GhlConnectionStore } from "./connections/GhlConnectionStore";
export type {
  GhlConnection,
  GhlConnectionStatus,
  CreateGhlConnectionInput,
  UpdateGhlConnectionInput,
} from "./connections/GhlConnectionTypes";

// JAK-104 — multi-tenant GHL API v2 client (per-location auth, retries, backoff).
export {
  GhlApiClient,
  GhlApiError,
  GhlConnectionUnavailableError,
} from "./api/GhlApiClient";
export type {
  GhlContact,
  GhlCustomField,
  GhlCustomFieldValue,
  GhlNote,
  CreateCustomFieldInput,
} from "./api/GhlApiTypes";
