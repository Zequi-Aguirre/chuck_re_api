# Jake for GoHighLevel — Lead-Enrichment Marketplace App

**Status:** Spec — MVP for beta users
**Owner:** Zequi
**Author:** Zack
**Date:** 2026-07-01
**Repo:** `/Users/zequiaguirre/Documents/Dev/jake`

---

## 1. Goal

A GoHighLevel (GHL) Marketplace app that, once installed into a sub-account,
**automatically enriches every new contact** using Jake's existing enrichment
engine, and writes the results back into the sub-account — no manual lookups,
no leaving the CRM.

Jake-by-text stays the top-of-funnel discovery product. This app is the
"done-for-you" upsell: the lead lands in their CRM already enriched.

**North star for the build: dead simple.** Install → new lead comes in →
it gets enriched → data appears on the contact. Everything else supports that
one sentence.

---

## 2. Product model (context, not all built now)

Monetization ladder:
1. **Jake by text** — discovery. "I can have this done for me automatically?"
2. **Enrichment app** — tiered SaaS (~$100/mo, tiers TBD). This spec.
3. **No CRM?** — sell them a GHL sub-account (GHL SaaS mode resale).
4. **Bundle** — CRM + enrichment, with AskZoe as the "do you even need a CRM?" concierge.

Tiers, billing, and marketplace public-listing are **deferred** (see §9). We
launch to beta users with **private install links** first.

---

## 3. Architecture

Reuse Jake's existing stack — this is why the build is weeks, not months:

| Need | Already in Jake |
|---|---|
| HTTP (OAuth + webhook) | Express |
| DI / structure | tsyringe + reflect-metadata (Automator pattern) |
| Token + usage store | Postgres (pg / pg-promise) |
| Webhook queue | BullMQ + Redis (ioredis / Upstash) |
| GHL API calls | axios |
| Secrets | Doppler |
| Billing (later) | Stripe |

Follow the Automator/Northstar conventions already in memory:
- Canonical env source via a single env helper (`isProduction/isStaging/isDev`).
- Doppler for all secrets; nothing hardcoded.
- **Dev/staging never writes to real buyer/customer systems** — same rule
  applies here: dev never writes to a real GHL sub-account (see §8).
- DB column naming, timestamp naming, no password/secret in plaintext — per
  existing feedback rules.

---

## 4. Core flow

```
Install (OAuth)
  └─ store per-location access + refresh token (encrypted)
  └─ auto-provision Jake custom fields in that sub-account
  └─ drop a welcome note

New contact created in sub-account
  └─ GHL fires ContactCreate webhook → our /webhooks/ghl endpoint
       └─ verify signature, return 200 fast, enqueue job (BullMQ)

Enrichment worker (consumes queue)
  └─ load contact from GHL (address/name)
  └─ run Jake enrichment engine (existing)
  └─ normalize output
  └─ write back: custom fields + one "Jake Enrichment" note
  └─ record usage (metering) + mark contact enriched (idempotency)
```

---

## 4a. Text-Jake: two modes + master gateway key (JAK-115)

Text-Jake (the top-of-funnel "text me an address" product) runs in **two modes,
selected per customer** via a `text_mode` field on the connection record. This
supersedes part of JAK-114 (which had made ALL text send/receive use per-location
connection-store creds).

**Mode `gateway` — DEFAULT (tier-1 / trial).** Inbound and outbound texts flow
through **one Zequi-owned "Jake" GHL sub-account** — the SMS gateway — using a
**single MASTER GATEWAY KEY**. That key + its location id + base URL are
**app-level Doppler secrets** (`JAKE_GATEWAY_GHL_API_KEY`,
`JAKE_GATEWAY_LOCATION_ID`, `JAKE_GATEWAY_BASE_URL`) — **never stored in the DB,
never per-tenant.** Zequi's number, Zequi pays the SMS. This is for trial users
and anyone not on the tier-2 enrichment plan.

**Mode `own_number` — OPT-IN (offered at tier-2 enrichment signup).** Text-Jake
runs **inside the customer's OWN GHL sub-account**, using their already-stored
**encrypted per-tenant key** (the JAK-102 connection store) + a phone number they
assign to Jake. Their team texts that number → their GHL → Jake → replies out
their number. **The SMS cost shifts to the customer.** This is exactly the
per-tenant text routing JAK-114 built — preserved, now as the `own_number` path.

**Billing (both modes).** The texting customer is resolved by **sender phone
number** → a `text_jake_customers` row (upserted, keyed by phone) → that
customer's prepaid credits are drawn down via the JAK-109 ledger. A texter always
maps to the same customer + credit account; two phones never share one.

**Status notes (both modes).** Jake writes short status notes onto the customer's
contact ("looked up 123 Main St", "out of credits", "lookup failed") via
whichever mode's client.

**Isolation.** `own_number` customers never share creds or numbers (per-tenant key
+ a reply-from number proven to belong to that connection). The `gateway` path
never touches a tenant key. **Tier-2 enrichment write-back still uses the correct
per-tenant key** — the connection store remains the credential source for
enrichment and for `own_number` text.

---

## 5. Components (→ tickets)

- **App scaffolding + env/secrets** — module structure, Doppler config, env helper.
- **OAuth install/callback** — install link → code exchange → per-location token store (encrypted at rest).
- **Token refresh** — refresh before expiry; handle revoked/uninstalled.
- **GHL API client** — axios wrapper, per-location auth injection, retries, rate-limit backoff.
- **Install lifecycle** — on install: auto-create the canonical Jake custom fields + welcome note; on uninstall: mark location inactive, stop processing.
- **Webhook receiver** — `ContactCreate` (and optionally `ContactUpdate`); signature verify; fast 200; enqueue.
- **Enrichment worker** — queue consumer; Jake engine → write-back to fields + note; idempotent (never double-enrich the same contact).
- **Field mapping module** — the single canonical Jake→GHL field set (names, keys, types) and the mapping from enrichment output to field values. One place, so a mapping change never leaks.
- **Usage metering** — per-location enrichment log (feeds future tier caps + billing).
- **Dev/staging safety** — mock GHL in dev; a single echo sink; zero real writes off prod.
- **Failure handling** — retries, dead-letter queue, surfaced errors.
- **Minimal status view** — installs + enrichment counts (reuse the existing React admin shell; keep it thin).

---

## 6. Data model (Postgres, first pass — keep minimal)

- `ghl_installations` — one row per installed location: location_id, tokens
  (encrypted), scopes, installed_at, uninstalled_at, status.
- `ghl_custom_fields` — the field ids we provisioned per location (so write-back
  targets the right field ids).
- `ghl_enrichment_events` — per contact: location_id, contact_id, status,
  enriched_at, cost estimate, error. Powers idempotency + metering.
- `ghl_connections.text_mode` — `gateway` (default) | `own_number` per customer
  (JAK-115): which text-Jake mode + credential path handles their SMS.
- `text_jake_customers` — the tier-1 billing identity (JAK-115): one row per
  sender phone; its id doubles as the credit-account key against `credit_ledger`.

(Names/timestamps follow existing Jake/Automator column conventions.)

---

## 7. GHL specifics

- OAuth 2.0 app in the GHL developer portal; per-location tokens.
- Scopes (confirm at build): contacts read/write, custom fields, locations, notes.
- Webhook subscription: `ContactCreate` (+ `ContactUpdate` optional).
- **We auto-create the custom fields via the API on install** — the user does
  NOT hand-build fields. Optional 15-min white-glove is a bonus, not a requirement.
- Marketplace **public listing + approval requirements are deferred** (§9);
  beta runs on private install links, no review needed.

---

## 8. Dev / staging safety (hard rule)

Writing to a GHL sub-account is outbound to a real customer system. Same rule as
Automator's buyer dispatch:
- **Dev never writes to a real GHL location.** Local mock GHL client + echo sink.
- Staging uses a dedicated test sub-account only, never a customer's.
- Real writes happen only in prod, only for actually-installed locations.

---

## 9. Deferred (captured as tickets, NOT built now)

- **GHL Marketplace listing + approval** — logo, screenshots, demo video, scopes
  justification, privacy/terms URLs, submit for public review. **Post-beta.**
- **Tier pricing + billing** — Stripe or GHL native billing; enforce enrichment
  caps per tier; unit-economics model (cost-per-enrichment vs price). **Later.**
- **Onboarding** — white-glove flow + self-serve field-mapping guide.
- **Privacy Policy + Terms pages for Jake** — reuse the SublimadosYa scoped-block
  pattern.
- **CRM upsell bundle** — resell GHL sub-accounts (SaaS mode) + AskZoe concierge.

---

## 10. Tickets

Tracked in the project-local SQLite ticket store (`tickets/tickets.db`),
prefix **`JAK`**, GHL-enrichment epic in the **JAK-100 block** (the existing
JAK-001..004 are the core Jake MVP). Deferred items are JAK-150+.

**Critical path (build spine first):**

`JAK-101 scaffolding → JAK-102 OAuth/token store → JAK-104 GHL API client →
JAK-105 install lifecycle (fields) → JAK-106 webhook receiver →
JAK-108 field mapping → JAK-107 enrichment worker`

Everything else (metering, status view, dead-letter) hangs off that spine.
Deferred to post-beta: marketplace approval, tiers/billing, onboarding,
privacy/terms, CRM upsell.

**JAK-115** is an architecture correction on top of the spine: the master
gateway key + two-mode (`gateway`/`own_number`) text-Jake routing described in
§4a. It reconciles JAK-114 — per-location text creds become the `own_number`
path, and the default `gateway` path uses the app-level master key.
