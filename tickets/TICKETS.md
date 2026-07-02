# Jake — GHL Enrichment Tickets

**Generated from `tickets/tickets.db` by `tickets/tix`. Don't hand-edit —**
**mutate via `tix add | done`, which regenerates this file. DB is the truth.**

---

Epic: `ghl-enrichment`

## In progress (7)
- [ ] **JAK-115** (P0) Master GHL gateway key + mode-aware text-Jake (gateway vs own_number) — depends: JAK-102, JAK-109, JAK-114
- [ ] **JAK-118** (P2) Remove dead scaffold-clone env vars (VITE_ASKZACK_CLIENT_URL/SERVER_URL, VITE_ASKZOE_SERVER_URL, LOCAL_NGROK_URL)
- [ ] **JAK-120** (P1) Comprehensive DEPLOY.md refresh: single up-to-date staging setup doc — depends: JAK-116, JAK-117, JAK-118, JAK-119
- [ ] **JAK-121** (P1) Add 'GHL setup' section to DEPLOY.md (connect GHL to the running server) — depends: JAK-120
- [ ] **JAK-122** (P1) Align Jake migrations to house pattern (postgrator-cli + postgres/migrate.sh, retire Supabase tooling) — depends: JAK-117
- [ ] **JAK-123** (P1) DEPLOY.md: add explicit 'Render Service Settings' block (build-admin gotcha) — depends: JAK-121
- [ ] **JAK-125** (P1) Superadmin role: restrict admin management (add/manage/deactivate/reset-password) to superadmins — depends: JAK-113, JAK-124

## Open (4)
- [ ] **JAK-103** (P0) Token refresh service — depends: JAK-102
- [ ] **JAK-117** (P1) Align DB config to house pattern (discrete DB_* vars, mirror Automator/Northstar)
- [ ] **JAK-119** (P1) Retire legacy single-tenant GHL_API_KEY + GHL_BASE_URL path (chuck_re_api MVP leftovers)
- [ ] **JAK-124** (P1) Admin management: logged-in admin can create another admin — depends: JAK-113

## Deferred / blocked (5)
- [ ] **JAK-150** (P3) [LATER] GHL Marketplace listing + approval requirements
- [ ] **JAK-151** (P3) [LATER] Tier pricing + billing + enrichment caps + unit economics — depends: JAK-109
- [ ] **JAK-152** (P3) [LATER] Onboarding: white-glove + self-serve field-mapping guide — depends: JAK-105
- [ ] **JAK-153** (P3) [LATER] Privacy Policy + Terms pages for Jake
- [ ] **JAK-154** (P3) [LATER] CRM upsell bundle (GHL SaaS resale + AskZoe concierge)

## Done (15)
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
- [x] **JAK-113** (P0) Admin dashboard: email/password auth + sub-account connection CRUD — depends: JAK-101, JAK-102
- [x] **JAK-114** (P0) Multi-tenant text-Jake routing (migrate MVP off single Doppler key) — depends: JAK-102
- [x] **JAK-116** (P1) Deploy runbook: DEPLOY.md for Render staging bring-up
