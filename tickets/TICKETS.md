# Jake — GHL Enrichment Tickets

**Generated from `tickets/tickets.db` by `tickets/tix`. Don't hand-edit —**
**mutate via `tix add | done`, which regenerates this file. DB is the truth.**

---

Epic: `ghl-enrichment`

## Open (3)
- [ ] **JAK-103** (P0) Token refresh service — depends: JAK-102
- [ ] **JAK-113** (P0) Admin dashboard: email/password auth + sub-account connection CRUD — depends: JAK-101, JAK-102
- [ ] **JAK-114** (P0) Multi-tenant text-Jake routing (migrate MVP off single Doppler key) — depends: JAK-102

## Deferred / blocked (5)
- [ ] **JAK-150** (P3) [LATER] GHL Marketplace listing + approval requirements
- [ ] **JAK-151** (P3) [LATER] Tier pricing + billing + enrichment caps + unit economics — depends: JAK-109
- [ ] **JAK-152** (P3) [LATER] Onboarding: white-glove + self-serve field-mapping guide — depends: JAK-105
- [ ] **JAK-153** (P3) [LATER] Privacy Policy + Terms pages for Jake
- [ ] **JAK-154** (P3) [LATER] CRM upsell bundle (GHL SaaS resale + AskZoe concierge)

## Done (12)
- [x] **JAK-100** (P0) Project ticket store (SQLite in-repo)
- [x] **JAK-101** (P0) GHL app scaffolding + Doppler config + env helper — depends: JAK-100
- [x] **JAK-102** (P0) Encrypted connection/credential store — depends: JAK-101
- [x] **JAK-104** (P0) GHL API client (axios, per-location auth, retries, rate-limit) — depends: JAK-103
- [x] **JAK-105** (P0) Install lifecycle: auto-provision custom fields + welcome note; uninstall — depends: JAK-104
- [x] **JAK-106** (P0) Webhook receiver (ContactCreate/Update) + signature verify + enqueue — depends: JAK-101
- [x] **JAK-107** (P0) Enrichment worker: queue -> Jake engine -> write-back + idempotency — depends: JAK-104, JAK-105, JAK-106, JAK-108
- [x] **JAK-108** (P0) Field mapping module (canonical Jake->GHL field set + output mapping) — depends: JAK-101
- [x] **JAK-109** (P1) Usage metering (per-location enrichment log) — depends: JAK-107
- [x] **JAK-110** (P0) Dev/staging safety: mock GHL, no real writes off prod — depends: JAK-104
- [x] **JAK-111** (P1) Failure handling: retries, dead-letter, error surfacing — depends: JAK-107
- [x] **JAK-112** (P2) Minimal install/usage status view — depends: JAK-109
