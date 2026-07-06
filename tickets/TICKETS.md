# Jake — GHL Enrichment Tickets

**Generated from `tickets/tickets.db` by `tickets/tix`. Don't hand-edit —**
**mutate via `tix add | done`, which regenerates this file. DB is the truth.**

---

Epic: `ghl-enrichment`

## In progress (16)
- [ ] **JAK-115** (P0) Master GHL gateway key + mode-aware text-Jake (gateway vs own_number) — depends: JAK-102, JAK-109, JAK-114
- [ ] **JAK-118** (P2) Remove dead scaffold-clone env vars (VITE_ASKZACK_CLIENT_URL/SERVER_URL, VITE_ASKZOE_SERVER_URL, LOCAL_NGROK_URL)
- [ ] **JAK-120** (P1) Comprehensive DEPLOY.md refresh: single up-to-date staging setup doc — depends: JAK-116, JAK-117, JAK-118, JAK-119
- [ ] **JAK-121** (P1) Add 'GHL setup' section to DEPLOY.md (connect GHL to the running server) — depends: JAK-120
- [ ] **JAK-122** (P1) Align Jake migrations to house pattern (postgrator-cli + postgres/migrate.sh, retire Supabase tooling) — depends: JAK-117
- [ ] **JAK-123** (P1) DEPLOY.md: add explicit 'Render Service Settings' block (build-admin gotcha) — depends: JAK-121
- [ ] **JAK-125** (P1) Superadmin role: restrict admin management (add/manage/deactivate/reset-password) to superadmins — depends: JAK-113, JAK-124
- [ ] **JAK-126** (P1) Responsive admin dashboard with left sidebar nav (MUI Drawer) — depends: JAK-113, JAK-125
- [ ] **JAK-127** (P1) Add inbound debug logging to SMS webhook (prove GHL {{message.body}} resolution)
- [ ] **JAK-128** (P0) Fix inbound SMS: message arrives as object {type,body}, address never parses — depends: JAK-127
- [ ] **JAK-129** (P0) Admin can grant credits to a text-Jake customer by phone — depends: JAK-115, JAK-109, JAK-113
- [ ] **JAK-130** (P0) Reformat text-Jake reply into structured 'Jake Property Report' — depends: JAK-115, JAK-128
- [ ] **JAK-131** (P1) Admin-editable AI prompt for the Jake Property Report — depends: JAK-130
- [ ] **JAK-132** (P1) Feed FULL PropertySearch response to AI report writer; guarantee mortgage/foreclosure/lien flags surface — depends: JAK-130, JAK-131
- [ ] **JAK-133** (P0) HOTFIX: restore edited-in-place applied migration (unbreak staging deploy) + adopt real-timestamp migration tooling — depends: JAK-132
- [ ] **JAK-162** (P1) Admin UI for the per-feature credit-bucket split (grant-by-type, 3 balances, editable default grants + out-of-credits messages) — depends: JAK-161, JAK-129, JAK-131

## Open (5)
- [ ] **JAK-103** (P0) Token refresh service — depends: JAK-102
- [ ] **JAK-117** (P1) Align DB config to house pattern (discrete DB_* vars, mirror Automator/Northstar)
- [ ] **JAK-119** (P1) Retire legacy single-tenant GHL_API_KEY + GHL_BASE_URL path (chuck_re_api MVP leftovers)
- [ ] **JAK-124** (P1) Admin management: logged-in admin can create another admin — depends: JAK-113
- [ ] **JAK-149** (P1) Mobile-first admin pages: cards on mobile for all data tables, no horizontal scroll — depends: JAK-146

## Deferred / blocked (4)
- [ ] **JAK-150** (P3) [LATER] GHL Marketplace listing + approval requirements
- [ ] **JAK-151** (P3) [LATER] Tier pricing + billing + enrichment caps + unit economics — depends: JAK-109
- [ ] **JAK-152** (P3) [LATER] Onboarding: white-glove + self-serve field-mapping guide — depends: JAK-105
- [ ] **JAK-153** (P3) [LATER] Privacy Policy + Terms pages for Jake

## Done (35)
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
- [x] **JAK-134** (P1) Conversation memory store: per-phone conversation history in Postgres
- [x] **JAK-135** (P1) Orchestrator / router AI: intent classification + dispatch plan — depends: JAK-134
- [x] **JAK-136** (P1) Skip-trace specialist: RealEstate API skip-trace DAO + specialist AI — depends: JAK-135
- [x] **JAK-137** (P1) Comps specialist: RealEstate API comparables/CMA DAO + specialist AI — depends: JAK-135
- [x] **JAK-138** (P2) Conversational UX polish: follow-ups, disambiguation, confirm-before-spend — depends: JAK-135, JAK-136, JAK-137
- [x] **JAK-140** (P0) P0 hotfix: inbound SMS 500 — min(uuid) in ConversationStore.resolvedAddresses — depends: JAK-134
- [x] **JAK-141** (P1) Provider-agnostic LLM layer: OpenAI (default gpt-4o) + Anthropic, keys in Doppler — depends: JAK-135, JAK-136, JAK-137
- [x] **JAK-143** (P1) Per-prompt provider + model picker on each prompt-edit page (keys stay in Doppler) — depends: JAK-141
- [x] **JAK-144** (P0) Fix skip-trace + comps no-data bug + remove confirm-before-spend — depends: JAK-136, JAK-137, JAK-138
- [x] **JAK-145** (P0) Skip-trace the property OWNER + group results by person (+ per-person cache key) — depends: JAK-136, JAK-144
- [x] **JAK-146** (P0) Text-customer profile fields (name/email) + mobile-first text-customers admin page — depends: JAK-129, JAK-115
- [x] **JAK-147** (P0) Sync text customer to Jake GHL sub-account + set 'text Jake' approval field — depends: JAK-146, JAK-104, JAK-102, JAK-110
- [x] **JAK-148** (P0) Two-level hold for text customers (soft on-hold + hard deactivate) with GHL 'text Jake' field flip — depends: JAK-147, JAK-146, JAK-110
- [x] **JAK-154** (P0) Bare skip-trace/comps default to the MOST RECENT address (fix: re-ran an older/already-handled property) — depends: JAK-135, JAK-138, JAK-145
- [x] **JAK-156** (P0) Explicit address typed inside a skip/comps command targets THAT address (not a historical one) — depends: JAK-135, JAK-154, JAK-145
- [x] **JAK-157** (P1) Universal SMS footer -> 'Every lead deserves a Jake Report. / GoTextJake.com/crm' (replace GoTextJake.com)
- [x] **JAK-158** (P1) Universal SMS footer copy update -> 'Every Lead Deserves Jake. / GoTextJake.com/CRM' — depends: JAK-157
- [x] **JAK-159** (P0) Phrase "last" (the last one / last property) in skip/comps resolves to genuinely MOST-RECENT address, not the end of the first-appearance ordinal list — depends: JAK-154, JAK-156
- [x] **JAK-160** (P1) Comps output overhaul: year-built + days-on-market, REAL haversine distance, closest-5 sorted nearest-first — depends: JAK-137, JAK-144
- [x] **JAK-161** (P1) Split single Jake credit pool into 3 per-feature buckets (report/skiptrace/comps) — backend of credit-split epic — depends: JAK-109, JAK-136, JAK-137, JAK-144
