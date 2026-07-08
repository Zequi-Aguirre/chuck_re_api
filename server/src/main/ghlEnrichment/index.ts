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

// JAK-105 — install/uninstall lifecycle: auto-provision canonical Jake custom
// fields + welcome note on install; mark inactive on uninstall.
export {
  GhlInstallLifecycleService,
  WELCOME_NOTE_BODY,
} from "./lifecycle/GhlInstallLifecycleService";
export type {
  InstallResult,
  ProvisionedField,
  ProvisionOutcome,
} from "./lifecycle/GhlInstallLifecycleService";
export { GhlCustomFieldStore } from "./lifecycle/GhlCustomFieldStore";
export type {
  GhlCustomFieldRow,
  InsertGhlCustomFieldRow,
} from "./lifecycle/GhlCustomFieldStore";
export {
  JAKE_CUSTOM_FIELDS,
  normalizeFieldKey,
} from "./lifecycle/JakeCustomFields";
export type {
  JakeCustomFieldDef,
  JakeFieldDataType,
} from "./lifecycle/JakeCustomFields";

// JAK-106 — inbound ContactCreate webhook receiver: verify signature (shared
// GHL_WEBHOOK_SECRET), resolve the location, enqueue an enrichment job. Never
// enriches inline — that's JAK-107.
export { GhlEnrichmentWebhookResource } from "./webhook/GhlEnrichmentWebhookResource";
export { GhlWebhookVerifier } from "./webhook/GhlWebhookVerifier";
export type { WebhookVerificationResult } from "./webhook/GhlWebhookVerifier";
export type {
  ParsedContactWebhook,
  RawGhlWebhookBody,
} from "./webhook/GhlWebhookTypes";

// JAK-108 — pure enrichment → GHL custom-field mapping. Turns an EnrichmentResult
// + a location's field-id map into the updateContactCustomFields payload, using
// the one canonical field catalog (JAK-105) so keys never drift. No I/O.
export {
  mapEnrichmentToCustomFields,
  buildLocationFieldIdMap,
} from "./fieldMapping/EnrichmentFieldMapper";
export type { LocationFieldIdMap } from "./fieldMapping/EnrichmentFieldMapper";

// JAK-107 — enrichment worker: consumes an enqueued job and runs the full spine
// (connection → contact → Jake engine → JAK-108 mapping → write-back + note),
// idempotent + metered via the events store. The keystone of the pipeline.
export { GhlEnrichmentWorker } from "./worker/GhlEnrichmentWorker";
export type { EnrichmentOutcome } from "./worker/GhlEnrichmentWorker";
export { GhlEnrichmentEventStore } from "./worker/GhlEnrichmentEventStore";
export type {
  GhlEnrichmentEventRow,
  RecordEnrichmentEventInput,
  EnrichmentEventStatus,
} from "./worker/GhlEnrichmentEventStore";
export { buildEnrichmentNote, ENRICHMENT_NOTE_HEADING } from "./worker/EnrichmentNote";

// JAK-109 — credit metering: prepaid credit system. Config-driven per-operation
// costs, an append-only ledger + a maintained balance kept consistent with it,
// atomic charge (never overdraw, never half-charge), and a manual grant path for
// beta (Stripe top-ups deferred). The worker gates paid work on it.
export { CreditService } from "./metering/CreditService";
export type { CreditAccountSummary } from "./metering/CreditService";
export { CreditLedgerStore } from "./metering/CreditLedgerStore";
export type { CreditLedgerRow, ChargeResult } from "./metering/CreditLedgerStore";
export {
  DEFAULT_CREDIT_COSTS,
  enrichmentChargeLines,
  enrichmentCreditCost,
} from "./metering/CreditCosts";
export type {
  CreditCostConfig,
  EnrichmentCostPlan,
  CreditLedgerReason,
  CreditChargeLine,
} from "./metering/CreditCosts";

// JAK-112 — read-only status view: an internal API surfacing per-location health
// (connection state, credit balance + ledger, enrichment outcome counts + recent
// list, and the JAK-111 failed / dead-lettered records). Aggregates the existing
// stores; never returns a decrypted credential. The admin-dash UI is JAK-113.
export { GhlStatusService } from "./status/GhlStatusService";
export { GhlStatusResource } from "./status/GhlStatusResource";
export type {
  ConnectionStatusView,
  EnrichmentOutcomeCounts,
  LedgerEntryView,
  EnrichmentEventView,
  LocationStatusSummary,
  LocationStatusDetail,
} from "./status/GhlStatusTypes";

// JAK-113 — admin dashboard: email/password auth + sub-account CRUD. The beta
// onboarding UI + auth layer over the services above; reuses JAK-102/109/112,
// reimplements no business logic. Passwords are bcrypt-hashed; the API key is
// write-only (encrypted at rest, never returned after save).
export { AdminAuthResource } from "./admin/AdminAuthResource";
export { AdminResource } from "./admin/AdminResource";
export { AdminAuthService } from "./admin/AdminAuthService";
export { AdminConnectionService } from "./admin/AdminConnectionService";
export { AdminUserStore } from "./admin/AdminUserStore";
export { requireAdminAuth, ADMIN_COOKIE } from "./admin/requireAdminAuth";
export type {
  AdminUser,
  AdminUserRow,
  AdminTokenPayload,
  AdminConnectionView,
} from "./admin/AdminTypes";

// JAK-184 — deterministic REAPI PropertyDetail → GHL auto-enrichment formatter
// (epic JAK-180). Pure functions, NO LLM: maps a PropertyDetail subject into the
// logical auto-enrichment field VALUES (deal signals, MLS status, equity/mortgage,
// ownership, structure). JAK-185 maps these logical keys → per-location GHL field
// ids; JAK-183 wires it into the worker. This ticket ships the formatter + types
// + tests only — no endpoint/worker wiring.
export {
  formatPropertyDetailEnrichment,
  extractEnrichmentSubject,
} from "./autoEnrichment/PropertyDetailEnrichmentFormatter";
export type { FormatEnrichmentOptions } from "./autoEnrichment/PropertyDetailEnrichmentFormatter";
export type {
  AutoEnrichmentFields,
  MlsStatus,
  ReapiPropertyDetailSubject,
  ReapiPropertyDetailEnvelope,
  ReapiEnrichmentOwnerInfo,
  ReapiEnrichmentPropertyInfo,
  ReapiEnrichmentLotInfo,
  ReapiEnrichmentForeclosureItem,
  ReapiEnrichmentLastSale,
  ReapiEnrichmentAddress,
  ReapiNumberLike,
} from "./autoEnrichment/AutoEnrichmentTypes";
