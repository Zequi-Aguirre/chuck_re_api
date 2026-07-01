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

Env / secrets are Doppler-provided via `EnvConfig`:
`GHL_CLIENT_ID`, `GHL_CLIENT_SECRET`, `GHL_WEBHOOK_SECRET`,
`GHL_CREDENTIAL_ENC_KEY` (app-level encryption key only — a tenant's own GHL API
key is stored **encrypted in the DB**, never in Doppler).

Environment stage is resolved through the single canonical helper on
`EnvConfig`: `isProduction` / `isStaging` / `isDev` (Automator pattern). The
dev/staging write-safety rule (SPEC §8 — never write to a real GHL sub-account
off prod) reads these; do not re-derive the stage anywhere else.
