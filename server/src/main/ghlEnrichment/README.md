# GHL enrichment module

The GoHighLevel lead-enrichment Marketplace app. Full spec:
[`docs/ghl-enrichment/SPEC.md`](../../../../docs/ghl-enrichment/SPEC.md). Tickets:
`tickets/TICKETS.md` (epic `ghl-enrichment`, `JAK-100` block).

This module lives **inside** Jake's existing TS / Express / tsyringe server and
**extends the parked MVP scaffolding** — it does not duplicate it:

- `services/LeadEnrichmentQueueService.ts` — the Redis / BullMQ enrichment queue
  (only wired when Redis is configured): the JAK-106 webhook enqueues onto it and
  the JAK-107 `GhlEnrichmentWorker` consumes it.

> **JAK-119:** the original single-tenant MVP client (`data/GhlApiDao.ts`, the
> `/api/ghl/webhook` receiver, and the `LeadEnrichmentService`/`LeadEnrichmentWorker`
> pair) has been retired along with the Doppler `GHL_API_KEY` + `GHL_BASE_URL`
> creds. All GHL access now goes through the multi-tenant `GhlApiClient` with
> per-location credentials from the JAK-102 store.

## What JAK-101 added (scaffolding + config + DI only — no business logic)

- `config/GhlEnrichmentConfig.ts` — one typed surface for the module's settings,
  reading from the canonical `EnvConfig` (Doppler). Never reads `process.env`
  directly.
- `di/registerGhlEnrichment.ts` — the module's single DI wiring point, invoked
  from `di/registerDependencies.ts` during `JakeServer.setup()`.
- `index.ts` — public barrel.

## What JAK-102 added (encrypted connection/credential store)

The **single source of GHL credentials** for BOTH the enrichment webhook path
AND text-Jake (JAK-114). A `connection` is one row per sub-account (location):
`{ location_id, api_key (encrypted at rest), base_url, phone_numbers[] }`. GHL
creds live per-location in Postgres (encrypted at rest); Doppler keeps only the
app-level encryption key, never a tenant's own key or base URL.

- `connections/GhlConnectionTypes.ts` — the `GhlConnection` domain shape + I/O.
- `connections/CredentialCipher.ts` — AES-256-GCM encrypt/decrypt; 256-bit key
  derived from `GHL_CREDENTIAL_ENC_KEY`. API keys are never stored in plaintext.
- `connections/GhlConnectionStore.ts` — raw SQL CRUD over `data/PostgresDatabase`
  + resolvers by `location_id` and by phone number.
- `connections/GhlConnectionService.ts` — the injectable callers use; wraps store
  + cipher so callers work in plaintext while keys are stored encrypted. Abstracts
  "how we auth to a sub-account" (API key now, OAuth later).
- `data/PostgresDatabase.ts` — shared, lazily-initialized `pg` pool (Jake's first
  Postgres dependency). Pool opens on first query, so boot stays clean without a DB.
- Migration: `supabase/migrations/*_create_ghl_connections.sql`.

The admin CRUD UI (JAK-113) and text-Jake routing (JAK-114) build on this store;
they are **not** part of JAK-102.

## What JAK-106 added (inbound ContactCreate webhook receiver)

One endpoint — `POST /webhooks/ghl` — that GHL calls when a new contact is
created in an installed sub-account. It does the least possible synchronously and
hands the real enrichment to the worker (JAK-107) via the queue:

1. **Verify signature** — HMAC-SHA256 over the RAW request body keyed on
   `GHL_WEBHOOK_SECRET` (Doppler), hex, optional `sha256=` prefix, constant-time
   compare. This is the enrichment path's security boundary — it deliberately
   does **NOT** use `MASTER_API_KEY` (that guards the text path). Fails closed in
   prod when the secret is missing; off-prod it accepts unverified with a warning
   for local testing (the receiver only enqueues, so SPEC §8 write-safety holds).
2. **Validate** the payload (location id + contact id present).
3. **Resolve the location** from the JAK-102 connection store; drop (200 ignored)
   if the location is unknown or inactive (uninstalled), so GHL stops retrying.
4. **Enqueue** an enrichment job on the reused MVP BullMQ queue
   (`LeadEnrichmentQueueService`) — never inline. The job id is
   `ghl:<location>:<contact>`, so retries / duplicate deliveries collapse onto one
   job (idempotent).

- `webhook/GhlWebhookVerifier.ts` — shared-secret HMAC signature verification.
- `webhook/GhlWebhookTypes.ts` — raw body + parsed/routing types.
- `webhook/GhlEnrichmentWebhookResource.ts` — the Express route (raw-body capture,
  verify → validate → resolve → enqueue). Mounted in `JakeServer` BEFORE the
  app-wide `express.json()` so its route-scoped parser sees the raw bytes; gated
  on Redis like the parked pipeline.

Only `ContactCreate` is acted on; `ContactUpdate` (and anything else) is
acknowledged and dropped for the MVP. The enrichment worker body — loading the
contact, running the Jake engine, write-back, per-contact idempotency/metering —
is **JAK-107**, not part of JAK-106.

## What JAK-107 added (enrichment worker — the pipeline keystone)

The queue consumer that ties the whole spine together. It picks up the job the
JAK-106 webhook enqueues and, for that one contact, runs end-to-end:

1. **Idempotency first** — check `ghl_enrichment_events`; if the contact is
   already `enriched`, do nothing. Safe under GHL webhook retries / re-delivery
   even though the queue also dedupes at enqueue.
2. **Load the connection** (JAK-102) — skip (record `skipped`) if the location is
   unknown or inactive (uninstalled).
3. **Fetch the contact** via the JAK-104 `GhlApiClient.getContact` (per-location
   auth) — skip if it's gone (404).
4. **Run Jake's existing enrichment engine** — the parked MVP `RealEstateApiDao`
   property/skip-trace logic, REUSED not rebuilt — to produce an
   `EnrichmentResult`. The address is the one the webhook carried, else built
   from the contact GHL returned.
5. **Map** the result with the JAK-108 field mapper against the location's
   provisioned `ghl_custom_fields` id map.
6. **Write back** via `updateContactCustomFields` + drop a "Jake Enrichment"
   summary note via `createNote`. Both pass through the client's SPEC §8
   write-safety gate (dev echoes/skips; staging/prod write) — the worker never
   re-derives the stage.
7. **Record** the outcome (`enriched` / `skipped` / `failed`) for idempotency +
   metering.

- `worker/GhlEnrichmentWorker.ts` — the injectable orchestrator (`process(job)`).
- `worker/GhlEnrichmentEventStore.ts` — per-contact events store (idempotency +
  the metering log JAK-109 reads); UPSERTs one row per `(location, contact)`.
- `worker/EnrichmentNote.ts` — pure "Jake Enrichment" note rendering.
- Migration: `supabase/migrations/*_create_ghl_enrichment_events.sql`.
- `services/LeadEnrichmentQueueService` dispatches every job (each carries a
  `location_id` from the JAK-106 path) to the multi-tenant `GhlEnrichmentWorker`.

Failure handling is deliberately **minimal** (JAK-111 hardens it): transient GHL
failures (429/5xx/network) re-throw so BullMQ retries with backoff and the job
eventually lands in the failed set (a minimal dead-letter, `removeOnFail:false`);
permanent failures throw `UnrecoverableError` to skip straight to failed; expected
non-error outcomes are recorded as `skipped` and the job completes. Logs are
structured and secret-free — the decrypted Bearer token is never logged.

With JAK-107 the core enrichment spine is end-to-end
(JAK-104 → 105 → 106 → 108 → 107): install provisions fields, a new contact fires
the webhook, the job enqueues, and the worker enriches + writes back. What
remains off this spine: **JAK-111** failure-handling hardening, **JAK-113** admin
dashboard, and **JAK-114** multi-tenant text-Jake routing.

## What JAK-109 added (credit metering — the prepaid credit system)

The app runs on **prepaid credits**. Each location has a credit balance; the
worker charges against it and refuses paid work it can't afford. Billing / Stripe
top-ups are **deferred** — for beta, credits are added manually
(`CreditService.grantCredits`).

- `metering/CreditCosts.ts` — pure, config-driven cost model. Per-operation costs
  are constants sourced from Doppler (`CREDIT_COST_ENRICHMENT`,
  `CREDIT_COST_SKIP_TRACE`) with safe defaults (1 per record, **+2 extra** for a
  skip-trace *on top of* the base). A charge is itemized into lines (one
  `enrichment` line, plus a `skip_trace` line when applicable) so the ledger
  shows *what* was paid for.
- `metering/CreditLedgerStore.ts` — SQL data-access. Owns the only real
  concurrency in the module: `charge()` deducts **atomically** without
  overdrawing (row-locked `SELECT … FOR UPDATE` on `credit_balances`, balance
  update + ledger insert in one transaction — never a half-charge). `grant()`
  adds credits the same way. Balance is a maintained column kept consistent with
  the append-only ledger; `balance_after` snapshots make history reconstructable.
- `metering/CreditService.ts` — business surface: price a plan, check
  affordability, charge on success, grant (beta), and `getAccountSummary()` (the
  simple internal read of balance + recent ledger that JAK-112's status view
  builds on).
- Migration: `supabase/migrations/*_create_credit_ledger.sql` (`credit_ledger` +
  `credit_balances`; snake_case, `created/modified/deleted` timestamps, no FK so
  billing history outlives a connection delete).

Worker wiring: the worker checks the balance **before** any paid work; if short,
it records status `credit_blocked` and skips (no free enrichment, reprocesses
once credits are granted). On a successful write-back it deducts atomically and
records the charged amount as the event's `cost_estimate`. A no-property-match is
**not** charged (no value delivered). `skipTrace` is `false` on today's path —
the engine doesn't skip-trace yet; flipping the flag applies the extra cost
automatically. What remains: **JAK-111** failure hardening, **JAK-112/113**
status/admin views, **JAK-155** tier caps + Stripe billing.

Env / secrets are Doppler-provided via `EnvConfig`:
`GHL_CLIENT_ID`, `GHL_CLIENT_SECRET`, `GHL_WEBHOOK_SECRET`,
`GHL_CREDENTIAL_ENC_KEY` (app-level encryption key only — a tenant's own GHL API
key is stored **encrypted in the DB**, never in Doppler), and the discrete
Postgres vars `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASS` / `DB_DB` (HOUSE
PATTERN, shared with Automator + Northstar) backing the connection store.

Environment stage is resolved through the single canonical helper on
`EnvConfig`: `isProduction` / `isStaging` / `isDev` (Automator pattern). The
dev/staging write-safety rule (SPEC §8 — never write to a real GHL sub-account
off prod) reads these; do not re-derive the stage anywhere else.

## What JAK-113 added (admin dashboard — the beta onboarding path)

The internal dashboard where Zequi onboards beta sub-accounts. This is the **UI +
auth layer** over the existing services (JAK-102 connections, JAK-109 credits,
JAK-112 status) — it reimplements **no** business logic. (OAuth marketplace
install is deferred, JAK-150; today sub-accounts are connected by pasting a key.)

Backend (`admin/`):
- `AdminUserStore.ts` + migration `*_create_admin_users.sql` — the `admin_users`
  table. Passwords are stored **only** as a bcrypt hash (`password_hash`), never
  plaintext, never reversible.
- `AdminAuthService.ts` — bcrypt hash/verify (constant-time so a missing account
  can't be timed apart from a wrong password), JWT issue/verify signed with the
  app `JWT_SECRET`, and `seedFirstAdmin()` — the first admin is bootstrapped from
  `ADMIN_SEED_EMAIL` / `ADMIN_SEED_PASSWORD` (Doppler) at boot. **No credential
  is ever hardcoded in code or a migration.**
- `requireAdminAuth.ts` — middleware guarding every data route; reads the session
  JWT from the httpOnly `jake_admin_session` cookie (or a Bearer header).
- `AdminAuthResource.ts` — `POST /api/admin/auth/login|logout`, `GET .../me`. The
  JWT is delivered as an httpOnly, sameSite=lax cookie (secure in prod); login
  failures are a single generic 401 (no account enumeration).
- `AdminConnectionService.ts` — thin adapter: create/edit/rotate delegate to
  `GhlConnectionService` (key **encrypted at rest** via the JAK-102 cipher),
  deactivate to the JAK-104/110 inactive path (`GhlInstallLifecycleService`),
  credit grants to `CreditService`. Every value it returns is the masked
  `AdminConnectionView` — **the API key is write-only: never returned after save,
  never logged, never shown again** (only a constant `••••••••` mask).
- `AdminResource.ts` — the session-guarded data API under `/api/admin`: list
  (reuses JAK-112 `listLocationStatuses`), create, detail (reuses JAK-112
  `getLocationStatus`), edit/rotate, activate, deactivate, delete, and manual
  credit grant/adjustment.

Frontend (`client/`): a **separately-built** React + MUI SPA (`npm run
build-admin` → `client/dist`) **served by this same Express server** under
`/admin` (`JakeServer.mountAdminSpa`) — no second server, mirroring the
Automator/Northstar pattern. Login → list sub-accounts → connect one (paste key +
location id + base url) → per-account status (connection state, credit balance,
recent outcomes, failures) with edit/rotate/deactivate/delete and manual credit
grants.

To run locally: `npm run build-admin` (or `npm run dev-admin` for the Vite dev
server proxying `/api` to `:8080`), boot the server, and sign in at `/admin` with
the `ADMIN_SEED_*` credentials.
