import { DependencyContainer } from "tsyringe";
import { LlmClientResolver } from "../../services/llm/LlmClientResolver";
import { LlmModelSettingsService } from "../../services/llm/LlmModelSettingsService";
import { GhlEnrichmentConfig } from "../config/GhlEnrichmentConfig";
import { ExternalActionGuard } from "../../safety/ExternalActionGuard";
import { PostgresDatabase } from "../../data/PostgresDatabase";
import { AppSettingsStore } from "../../data/AppSettingsStore";
import { PropertyReportPromptService } from "../../services/PropertyReportPromptService";
import { OrchestratorPromptService } from "../../services/orchestrator/OrchestratorPromptService";
import { SpecialistRegistry } from "../../services/orchestrator/SpecialistRegistry";
import { JakeOrchestrator } from "../../services/orchestrator/JakeOrchestrator";
import {
  ROUTER_LLM_CLIENT,
  LlmRouterClient,
} from "../../services/orchestrator/RouterLlmClient";
import { CredentialCipher } from "../connections/CredentialCipher";
import { GhlConnectionStore } from "../connections/GhlConnectionStore";
import { GhlConnectionService } from "../connections/GhlConnectionService";
import { GhlApiClient } from "../api/GhlApiClient";
import { JakeGatewayClient } from "../gateway/JakeGatewayClient";
import { TextJakeCustomerStore } from "../customers/TextJakeCustomerStore";
import { TextJakeCustomerService } from "../customers/TextJakeCustomerService";
import { ConversationStore } from "../conversation/ConversationStore";
import { ConversationSettingsService } from "../conversation/ConversationSettingsService";
import { ConversationMemoryService } from "../conversation/ConversationMemoryService";
import { SkipTracePromptService } from "../../services/skiptrace/SkipTracePromptService";
import { SkipTraceSettingsService } from "../../services/skiptrace/SkipTraceSettingsService";
import { SkipTraceStore } from "../../services/skiptrace/SkipTraceStore";
import { SkipTraceMemoryService } from "../../services/skiptrace/SkipTraceMemoryService";
import { CompsPromptService } from "../../services/comps/CompsPromptService";
import { CompsSettingsService } from "../../services/comps/CompsSettingsService";
import { CompsStore } from "../../services/comps/CompsStore";
import { CompsMemoryService } from "../../services/comps/CompsMemoryService";
import { GhlCustomFieldStore } from "../lifecycle/GhlCustomFieldStore";
import { GhlInstallLifecycleService } from "../lifecycle/GhlInstallLifecycleService";
import { LeadEnrichmentQueueService } from "../../services/LeadEnrichmentQueueService";
import { GhlWebhookVerifier } from "../webhook/GhlWebhookVerifier";
import { GhlEnrichmentWebhookResource } from "../webhook/GhlEnrichmentWebhookResource";
import { GhlEnrichmentEventStore } from "../worker/GhlEnrichmentEventStore";
import { GhlEnrichmentWorker } from "../worker/GhlEnrichmentWorker";
import { CreditLedgerStore } from "../metering/CreditLedgerStore";
import { CreditService } from "../metering/CreditService";
import { GhlStatusService } from "../status/GhlStatusService";
import { GhlStatusResource } from "../status/GhlStatusResource";
import { AdminUserStore } from "../admin/AdminUserStore";
import { AdminAuthService } from "../admin/AdminAuthService";
import { AdminConnectionService } from "../admin/AdminConnectionService";
import { AdminTextCustomerService } from "../admin/AdminTextCustomerService";
import { AdminAuthResource } from "../admin/AdminAuthResource";
import { AdminResource } from "../admin/AdminResource";

/**
 * DI registration for the GHL enrichment module.
 *
 * tsyringe auto-resolves @injectable classes, so this is the module's single
 * explicit wiring point: it makes shared singletons obvious and gives later
 * tickets one function to hang new registrations on (OAuth service, webhook
 * verifier, field mapping…).
 *
 * It EXTENDS the existing MVP scaffolding (the parked Redis enrichment queue)
 * — it does not duplicate it.
 *
 * Registrations are lazy singletons: nothing here connects to Postgres or reads
 * the encryption key at boot — the connection store initializes its pool on the
 * first query — so the server still boots on environments without a DB.
 */
export const registerGhlEnrichment = (c: DependencyContainer): void => {
  if (!c.isRegistered(GhlEnrichmentConfig)) {
    c.registerSingleton(GhlEnrichmentConfig);
  }

  // JAK-110 — the single dev-safety boundary. One env-gated guard that every
  // outbound transport (GhlApiClient writes, RealEstate paid lookups) consults,
  // so real/costly/customer-visible actions are structurally impossible off
  // prod/staging and can't be re-toggled per-call.
  if (!c.isRegistered(ExternalActionGuard)) {
    c.registerSingleton(ExternalActionGuard);
  }

  // JAK-102 — encrypted per-location connection/credential store. The single
  // source of GHL credentials for both the enrichment webhook path and
  // text-Jake (JAK-114). One shared pool + cipher + store + service.
  if (!c.isRegistered(PostgresDatabase)) {
    c.registerSingleton(PostgresDatabase);
  }
  if (!c.isRegistered(CredentialCipher)) {
    c.registerSingleton(CredentialCipher);
  }
  if (!c.isRegistered(GhlConnectionStore)) {
    c.registerSingleton(GhlConnectionStore);
  }
  if (!c.isRegistered(GhlConnectionService)) {
    c.registerSingleton(GhlConnectionService);
  }

  // JAK-104 — multi-tenant GHL API v2 client. Pulls per-location credentials
  // from the JAK-102 connection store (decrypted key + base_url), NOT from a
  // single Doppler key. Handles retries + rate-limit backoff. This is the
  // canonical per-location transport.
  if (!c.isRegistered(GhlApiClient)) {
    c.registerSingleton(GhlApiClient);
  }

  // JAK-115 — text-Jake master gateway + tier-1 billing identity. The gateway
  // client fronts text_mode='gateway' (Zequi's shared Jake sub-account on the
  // app-level master key from Doppler — never a per-tenant key). The customer
  // store/service resolve the texting customer by sender phone and expose their
  // JAK-109 credit account. own_number mode reuses the JAK-104 client + JAK-102
  // store already registered above. Shares the one Postgres pool.
  if (!c.isRegistered(JakeGatewayClient)) {
    c.registerSingleton(JakeGatewayClient);
  }
  if (!c.isRegistered(TextJakeCustomerStore)) {
    c.registerSingleton(TextJakeCustomerStore);
  }
  if (!c.isRegistered(TextJakeCustomerService)) {
    c.registerSingleton(TextJakeCustomerService);
  }

  // JAK-105 — install/uninstall lifecycle. On install: auto-provision the
  // canonical Jake custom fields via the JAK-104 client and record their
  // per-location ids in ghl_custom_fields; drop a welcome note. On uninstall:
  // mark the connection inactive (the client already refuses inactive ones).
  // Builds on JAK-102 + JAK-104 — no duplicated credential/HTTP handling.
  if (!c.isRegistered(GhlCustomFieldStore)) {
    c.registerSingleton(GhlCustomFieldStore);
  }
  if (!c.isRegistered(GhlInstallLifecycleService)) {
    c.registerSingleton(GhlInstallLifecycleService);
  }

  // JAK-106 — inbound ContactCreate webhook receiver. Verifies the shared
  // GHL_WEBHOOK_SECRET signature (NOT the MASTER_API_KEY text path), resolves the
  // location from the JAK-102 store, and enqueues an enrichment job on the parked
  // MVP BullMQ queue — it never enriches inline (that's JAK-107). The queue
  // service is registered as a shared singleton so the receiver and the
  // worker-starter in JakeServer add to / consume the SAME queue instance.
  if (!c.isRegistered(LeadEnrichmentQueueService)) {
    c.registerSingleton(LeadEnrichmentQueueService);
  }
  if (!c.isRegistered(GhlWebhookVerifier)) {
    c.registerSingleton(GhlWebhookVerifier);
  }
  if (!c.isRegistered(GhlEnrichmentWebhookResource)) {
    c.registerSingleton(GhlEnrichmentWebhookResource);
  }

  // JAK-107 — enrichment worker: the keystone that consumes an enqueued job and
  // runs the full spine (load connection → fetch contact → Jake engine →
  // JAK-108 mapping → write-back + note), idempotent via the events store. The
  // JAK-106 queue routes multi-tenant jobs to GhlEnrichmentWorker; both share
  // the singletons above so there's one client / store / field-map instance.
  if (!c.isRegistered(GhlEnrichmentEventStore)) {
    c.registerSingleton(GhlEnrichmentEventStore);
  }

  // JAK-109 — credit metering: the prepaid credit system the worker charges
  // against. The ledger store owns atomic deduct-without-overdraw (row-locked
  // txn against credit_balances) + the append-only credit_ledger; the service
  // wraps it with the config-driven per-operation costs and the balance read.
  // Registered BEFORE the worker so its injection resolves. Shares the one
  // Postgres pool with every other store.
  if (!c.isRegistered(CreditLedgerStore)) {
    c.registerSingleton(CreditLedgerStore);
  }
  if (!c.isRegistered(CreditService)) {
    c.registerSingleton(CreditService);
  }

  if (!c.isRegistered(GhlEnrichmentWorker)) {
    c.registerSingleton(GhlEnrichmentWorker);
  }

  // JAK-112 — read-only status view: an internal API that aggregates the stores
  // above (connections + custom fields + events + credit ledger) into per-location
  // health. Adds no persistence and duplicates no query logic — it wraps what
  // JAK-102/105/107/109/111 already expose. The admin-dash UI is JAK-113.
  if (!c.isRegistered(GhlStatusService)) {
    c.registerSingleton(GhlStatusService);
  }
  if (!c.isRegistered(GhlStatusResource)) {
    c.registerSingleton(GhlStatusResource);
  }

  // JAK-113 — admin dashboard: the beta onboarding UI + its auth/data API. This
  // is the UI + auth LAYER over the services above (JAK-102 connections, JAK-109
  // credits, JAK-112 status) — it reuses them, reimplementing no business logic.
  // Admin users authenticate with a bcrypt-hashed password (AdminUserStore /
  // AdminAuthService) and the CRUD/status/credits API (AdminResource) is fully
  // session-guarded. Shares the one Postgres pool with every other store.
  if (!c.isRegistered(AdminUserStore)) {
    c.registerSingleton(AdminUserStore);
  }
  if (!c.isRegistered(AdminAuthService)) {
    c.registerSingleton(AdminAuthService);
  }
  if (!c.isRegistered(AdminConnectionService)) {
    c.registerSingleton(AdminConnectionService);
  }
  // JAK-129 — grant credits to a tier-1 text-Jake customer BY PHONE. Reuses the
  // JAK-115 customer resolution + the JAK-109 credit ledger; the customer id is
  // the credit-account key, so a gateway texter (no sub-account) can be topped
  // up. Shares the one Postgres pool.
  if (!c.isRegistered(AdminTextCustomerService)) {
    c.registerSingleton(AdminTextCustomerService);
  }
  if (!c.isRegistered(AdminAuthResource)) {
    c.registerSingleton(AdminAuthResource);
  }

  // JAK-131 — admin-editable AI prompt. The app_settings KV store backs the
  // editable STYLE/FORMAT prompt for the JAK-130 property report; the prompt
  // service owns the default + a short-TTL cache and is a SINGLETON so an admin
  // edit busts the same cache the PropertyReportWriter reads. The HARD guardrails
  // (no emojis / only-provided-values / GoTextJake.com footer) stay in the writer,
  // not here. Shares the one Postgres pool.
  if (!c.isRegistered(AppSettingsStore)) {
    c.registerSingleton(AppSettingsStore);
  }
  if (!c.isRegistered(PropertyReportPromptService)) {
    c.registerSingleton(PropertyReportPromptService);
  }

  // JAK-134 — conversation memory + property lookup cache: the FOUNDATION of the
  // Conversational Text-Jake epic. The store persists ordered per-phone history +
  // paid-lookup snapshots; the settings service fronts the two admin-configurable
  // knobs (context_window_size, free_reserve_window_days) via the SAME app_settings
  // KV store as JAK-131; the memory service is the read/write business surface the
  // assistant uses for the free re-serve rule. All singletons; share the one pool.
  if (!c.isRegistered(ConversationStore)) {
    c.registerSingleton(ConversationStore);
  }
  if (!c.isRegistered(ConversationSettingsService)) {
    c.registerSingleton(ConversationSettingsService);
  }
  if (!c.isRegistered(ConversationMemoryService)) {
    c.registerSingleton(ConversationMemoryService);
  }

  // JAK-135 — orchestrator / router AI: the brain that classifies EVERY inbound
  // message + resolves references into a typed dispatch plan, replacing the
  // single-path lookup with orchestrated dispatch. The prompt service fronts the
  // admin-editable orchestrator_prompt (same app_settings pattern as JAK-131);
  // the specialist registry is the name→descriptor seam JAK-136/137 register into
  // without rewriting the router; the router LLM client is injected behind a
  // token so tests mock it and never hit the network (dev/no-key falls back to a
  // deterministic, no-spend classification). All singletons; share the one pool.
  // JAK-141/143 — provider-agnostic LLM layer with PER-SURFACE model selection.
  // The resolver builds an LlmClient for a given {provider, model} (OpenAI by
  // default, Anthropic optional), memoizing one client per selection; the settings
  // service fronts each surface's admin-editable provider+model choice (same
  // app_settings pattern as the prompts), falling back to the global Doppler
  // default (LLM_PROVIDER / OPENAI_* / ANTHROPIC_*). The router + every specialist
  // writer resolve their own surface's selection per call. KEYS STAY IN DOPPLER —
  // this layer selects a provider+model, never reads/stores a key, and adds no key
  // entry anywhere. When the selected provider's key is unset, callers use their
  // deterministic fallbacks (router → rule-based; specialists → plain-text renderers).
  if (!c.isRegistered(LlmClientResolver)) {
    c.registerSingleton(LlmClientResolver);
  }
  if (!c.isRegistered(LlmModelSettingsService)) {
    c.registerSingleton(LlmModelSettingsService);
  }

  if (!c.isRegistered(OrchestratorPromptService)) {
    c.registerSingleton(OrchestratorPromptService);
  }
  if (!c.isRegistered(SpecialistRegistry)) {
    c.registerSingleton(SpecialistRegistry);
  }
  if (!c.isRegistered(ROUTER_LLM_CLIENT)) {
    c.registerSingleton(ROUTER_LLM_CLIENT, LlmRouterClient);
  }
  if (!c.isRegistered(JakeOrchestrator)) {
    c.registerSingleton(JakeOrchestrator);
  }

  // JAK-136 — skip-trace specialist: the first real specialist behind the JAK-135
  // registry seam. The prompt service fronts the admin-editable skiptrace_prompt
  // and the settings service the admin-editable skip-trace credit cost (both the
  // SAME app_settings pattern as JAK-131/135); the store persists the trace cache
  // + the ONE pending confirm-before-spend offer per phone; the memory service is
  // the free-re-serve business surface (reusing the JAK-134 free_reserve window).
  // SINGLETONS so an admin edit busts the same cache the specialist reads; share
  // the one Postgres pool. The DAO method + writer are auto-resolved like the
  // report writer.
  if (!c.isRegistered(SkipTracePromptService)) {
    c.registerSingleton(SkipTracePromptService);
  }
  if (!c.isRegistered(SkipTraceSettingsService)) {
    c.registerSingleton(SkipTraceSettingsService);
  }
  if (!c.isRegistered(SkipTraceStore)) {
    c.registerSingleton(SkipTraceStore);
  }
  if (!c.isRegistered(SkipTraceMemoryService)) {
    c.registerSingleton(SkipTraceMemoryService);
  }

  // JAK-137 — comps specialist: the second real specialist behind the JAK-135
  // registry seam. The prompt service fronts the admin-editable comps_prompt, and
  // the settings service the admin-editable comps credit cost AND the admin-editable
  // DEFAULT comp parameters (all the SAME app_settings pattern as JAK-131/135/136);
  // the store persists the comps cache (keyed per target + parameter-set) + the ONE
  // pending confirm-before-spend offer per phone; the memory service is the
  // free-re-serve business surface (reusing the JAK-134 free_reserve window).
  // SINGLETONS so an admin edit busts the same cache the specialist reads; share the
  // one Postgres pool. The DAO method + writer are auto-resolved like the report writer.
  if (!c.isRegistered(CompsPromptService)) {
    c.registerSingleton(CompsPromptService);
  }
  if (!c.isRegistered(CompsSettingsService)) {
    c.registerSingleton(CompsSettingsService);
  }
  if (!c.isRegistered(CompsStore)) {
    c.registerSingleton(CompsStore);
  }
  if (!c.isRegistered(CompsMemoryService)) {
    c.registerSingleton(CompsMemoryService);
  }

  if (!c.isRegistered(AdminResource)) {
    c.registerSingleton(AdminResource);
  }
};
