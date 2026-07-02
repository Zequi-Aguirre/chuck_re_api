# GHL enrichment module

The GoHighLevel lead-enrichment Marketplace app. Full spec:
[`docs/ghl-enrichment/SPEC.md`](../../../../docs/ghl-enrichment/SPEC.md). Tickets:
`tickets/TICKETS.md` (epic `ghl-enrichment`, `JAK-100` block).

This module lives **inside** Jake's existing TS / Express / tsyringe server and
**extends the parked MVP scaffolding** — it does not duplicate it:

- `data/GhlApiDao.ts` — GHL axios client (contacts, tags, SMS).
- `resources/GhlWebhookResource.ts` — `/api/ghl/webhook` receiver.
- `worker/LeadEnrichmentWorker.ts` + `services/LeadEnrichment*` — the Redis /
  BullMQ enrichment pipeline (only wired when Redis is configured).

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
`{ location_id, api_key (encrypted at rest), base_url, phone_numbers[] }`. It
replaces the single Doppler `GHL_API_KEY` + `GHL_BASE_URL` — those creds move
per-location into Postgres; Doppler keeps only the app-level encryption key.

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

Env / secrets are Doppler-provided via `EnvConfig`:
`GHL_CLIENT_ID`, `GHL_CLIENT_SECRET`, `GHL_WEBHOOK_SECRET`,
`GHL_CREDENTIAL_ENC_KEY` (app-level encryption key only — a tenant's own GHL API
key is stored **encrypted in the DB**, never in Doppler), and `DATABASE_URL`
(the Postgres connection string for the connection store).

Environment stage is resolved through the single canonical helper on
`EnvConfig`: `isProduction` / `isStaging` / `isDev` (Automator pattern). The
dev/staging write-safety rule (SPEC §8 — never write to a real GHL sub-account
off prod) reads these; do not re-derive the stage anywhere else.
