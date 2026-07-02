# DEPLOY — Jake staging on Render

The single, up-to-date runbook to bring up **staging on Render**. Every command,
env var, script, and migration below is real and reconciled against current
`develop`: the npm scripts are in `package.json`, the env vars in
`server/src/main/config/envConfig.ts`, the migrations in `supabase/migrations/`.
Do it in order.

Staging is a **server-only** deploy: one Express service serves both the JSON API
and the built admin SPA at `/admin` (`JakeServer.mountAdminSpa`). There is no
separate client deploy.

Staging URL used throughout: **https://chuck-re-api.onrender.com** (admin at
**https://chuck-re-api.onrender.com/admin**).

> **Scope:** staging = a dedicated GHL **test** sub-account, never a customer's
> (SPEC §8). Real GHL writes + outbound SMS fire in staging because
> `ExternalActionGuard.liveActionsAllowed = isProduction || isStaging` — that's
> why `ENV_STAGE=staging` is mandatory. Without it the server runs as dev and
> silently echo-skips every GHL write / SMS.

---

## 1. Provision Postgres on Render

1. Render Dashboard → **New +** → **PostgreSQL**.
2. Name it (e.g. `jake-staging-db`), pick a region + plan, **Create Database**.
3. Once it's live, open the DB → **Connections** and read off the discrete
   fields — **Hostname**, **Port**, **Username**, **Password**, **Database**.
   These map straight onto the `DB_*` vars in step 2. Jake uses discrete vars
   (`DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASS` / `DB_DB`) — the house pattern
   shared with Automator + Northstar — **not** a single `DATABASE_URL`.
   - **Render host gotcha:** the **Internal** hostname (a short name like
     `jake-staging-db`) only resolves in-cluster — use it for `DB_HOST` on the
     Render web service when the DB and service share a region (faster, no
     egress). To reach the DB from your laptop (e.g. migrations), use the
     **External** host, which is `${DB_HOST}.ohio-postgres.render.com`.

The schema is created by the migrations in step 3 — the DB starts empty.

---

## 2. Environment variables

Set these on the Render web service (or in a Doppler `stg` config synced to
Render). Every var below is one the code reads today in
`server/src/main/config/envConfig.ts` — nothing more, nothing retired.

Generate the secrets you'll need in group A:

```bash
openssl rand -base64 32   # GHL_CREDENTIAL_ENC_KEY
openssl rand -hex 32      # JWT_SECRET
openssl rand -hex 32      # MASTER_API_KEY
```

### (A) Set for you / generated

Known, fixed, or generated values — set once and move on.

| Var | Value / how to set |
|---|---|
| `ENV_STAGE` | `staging` — **mandatory**. Flips on real GHL writes + SMS (see callout above). |
| `DB_HOST` | Postgres hostname from step 1. Internal Render host in-cluster; external is `${DB_HOST}.ohio-postgres.render.com`. |
| `DB_PORT` | Postgres port (Render default `5432`). |
| `DB_USER` | Postgres username from step 1. |
| `DB_PASS` | Postgres password from step 1. |
| `DB_DB` | Postgres database name from step 1. |
| `JWT_SECRET` | Signs admin-session JWTs. Any long random string (`openssl rand -hex 32`). |
| `MASTER_API_KEY` | Internal header secret guarding `POST /api/sms/inbound` and `GET /api/ghl/status/*`. Any long random string; used in the smoke test (step 7). |
| `GHL_CREDENTIAL_ENC_KEY` | App-level secret that encrypts each tenant's GHL key at rest (AES-256-GCM, key = SHA-256 of this value). `openssl rand -base64 32`. |
| `JAKE_GATEWAY_BASE_URL` | GHL API base for the gateway client: `https://services.leadconnectorhq.com`. |
| `RE_API_KEY` | RealEstate API key (house key). Sent as `x-api-key` on text-Jake's property lookup. Unset → lookups return null and the smoke-test reply/note never happens. |
| `RE_BASE_URL` | RealEstate API base: `https://api.realestateapi.com`. |
| `ADMIN_SEED_EMAIL` | First-admin bootstrap email. Seeded once at boot, then unset (step 4). |
| `ADMIN_SEED_PASSWORD` | First-admin bootstrap password. Bcrypt-hashed at boot; never stored plaintext. Unset after first boot. |
| `CREDIT_COST_TEXT_LOOKUP` | *(optional)* Credits per text-Jake lookup. Default `1`. |
| `CREDIT_COST_ENRICHMENT` | *(optional)* Credits per enriched record. Default `1`. |
| `CREDIT_COST_SKIP_TRACE` | *(optional)* Extra credits per skip-trace. Default `2`. |
| `ADMIN_SESSION_TTL_HOURS` | *(optional)* Admin JWT lifetime in hours. Default `12`. |
| `REDIS_PROVIDER` | *(optional)* Default `upstash`. Leave unset. |
| `REDIS_URL` | *(optional)* Local Redis URL, default `redis://localhost:6379`. Not used with Upstash. |
| `ENRICH_QUEUE_NAME` | *(optional)* BullMQ queue name, default `lead-enrichment`. |
| `ENRICH_RPS` | *(optional)* Enrichment rate limit / sec, default `5`. |
| `PORT` | **Do not set** — Render injects it; the server binds `process.env.PORT \|\| 8080`. |

### (B) You must provide

No default exists — get each from the source noted.

| Var | What it is + where to get it |
|---|---|
| `JAKE_GATEWAY_GHL_API_KEY` | **Private Integration token of your Jake GHL sub-account** — the one shared "Jake" sub-account that fronts tier-1 / trial texting. In that GHL sub-account: Settings → Private Integrations → create one, copy the token. App-level only, **never** stored in the DB. |
| `JAKE_GATEWAY_LOCATION_ID` | **That same sub-account's Location ID.** GHL → Settings → Business Profile (or the `location/` segment in the dashboard URL). |
| `UPSTASH_REDIS_REST_URL` | REST endpoint of an **Upstash Redis** database. Upstash console → your DB → REST API. **Needed for enrichment**; text-Jake works without it. |
| `UPSTASH_REDIS_REST_TOKEN` | REST auth token from the same Upstash DB (next to the REST URL). |
| `UPSTASH_REDIS_TCP_URL` | TCP connection URL (`rediss://…`) from the same Upstash DB. This is the one that **gates** the webhook + BullMQ worker mount — unset → they're skipped and the server boots text-Jake-only. |
| `GHL_WEBHOOK_SECRET` | A secret **you choose** and set on the GHL new-contact (ContactCreate) webhook; the receiver verifies inbound signatures against it. **Only needed for enrichment.** |

### (C) Optional / deferred

Not needed for staging bring-up — wire later when GHL Marketplace OAuth lands.

| Var | Purpose |
|---|---|
| `GHL_CLIENT_ID` | GHL Marketplace OAuth app client id (JAK-150, later). |
| `GHL_CLIENT_SECRET` | GHL Marketplace OAuth app client secret (JAK-150, later). |

> **Minimum for a text-Jake-only staging boot:** group A + the two
> `JAKE_GATEWAY_*` values from group B. Add the Upstash trio + `GHL_WEBHOOK_SECRET`
> only when you want lead enrichment.

---

## 3. Run migrations

Migrations live in `supabase/migrations/` and apply in timestamp order. They
create `ghl_connections`, `ghl_custom_fields`, `ghl_enrichment_events`,
`credit_ledger`, `admin_users`, `text_jake_customers`, harden the enrichment
failure state, and add the `text_mode` column. Point the Supabase CLI at the
Render DB, composing the URL from the discrete `DB_*` vars:

```bash
# Run from your laptop → use the EXTERNAL host (${DB_HOST}.ohio-postgres.render.com).
npx supabase db push \
  --db-url "postgresql://$DB_USER:$DB_PASS@$DB_HOST.ohio-postgres.render.com:$DB_PORT/$DB_DB"
```

> `npm run dev-db-migrate` is the same `supabase db push` wrapped in
> `doppler run -p jake -c dev` for **local** dev. For staging, target the Render
> DB directly with `--db-url` as above.

---

## 4. Build + boot

From the repo root (cwd must be the repo root so `client/dist` resolves at
`/admin`):

```bash
npm ci
npm run build-be      # tsc + bundle -> dist/server.js
npm run build-admin   # vite build client -> client/dist (served at /admin)
node dist/server.js   # boot (Render start command; PORT injected by Render)
```

On **first** boot with `ADMIN_SEED_EMAIL` + `ADMIN_SEED_PASSWORD` set, the server
creates the first admin and logs:

```
🔐 First admin user created from ADMIN_SEED_* env.
```

Then **unset `ADMIN_SEED_EMAIL` and `ADMIN_SEED_PASSWORD`** in Render and
redeploy. Re-seeding is idempotent (no-ops once the admin exists, never
overwrites the password), but leaving the seed password in the environment is
needless exposure. Rotate the password through the app, not by re-seeding.

> Local equivalent of the boot line (Doppler dev config):
> `npm start` → `doppler run -p jake -c dev -- node dist/server.js`.

---

## 5. Log in + onboard the first sub-account

1. Open **https://chuck-re-api.onrender.com/admin** and log in with the seeded
   email/password (`POST /api/admin/auth/login` sets the httpOnly
   `jake_admin_session` cookie).
2. Connect the first sub-account — the dashboard's "connect a sub-account (paste
   key)" action → `POST /api/admin/connections`:

```bash
curl -X POST https://chuck-re-api.onrender.com/api/admin/connections \
  -H "Content-Type: application/json" \
  --cookie "jake_admin_session=<session-cookie-from-login>" \
  -d '{
    "locationId": "<ghl-location-id>",
    "apiKey": "<the-tenant-GHL-Private-Integration-token>",
    "baseUrl": "https://services.leadconnectorhq.com",
    "phoneNumbers": ["+15551234567"]
  }'
```

The pasted `apiKey` is **encrypted at rest** (AES-256-GCM via
`GHL_CREDENTIAL_ENC_KEY`) before it touches the DB, and every response returns a
masked key (`••••••••`) — the plaintext is write-only.

---

## 6. The two text modes

Text-Jake runs in one of two modes per connection (`ghl_connections.text_mode`):

- **`gateway` (DEFAULT).** Trial / tier-1. Inbound + outbound texts flow through
  the one shared "Jake" GHL sub-account using the **master gateway key**
  (`JAKE_GATEWAY_*`, app-level, never in the DB). Jake's number, Jake pays SMS.
  New dashboard-onboarded connections start here.
- **`own_number` (OPT-IN, tier-2).** Text-Jake runs **inside the customer's own**
  GHL sub-account using their **encrypted per-tenant key** (the pasted key from
  step 5) + a number they assign to Jake. SMS cost shifts to the customer. This
  is the JAK-114 per-tenant routing.

> The admin create/update API sets no `text_mode`, so every dashboard-onboarded
> connection defaults to `gateway`. Flipping to `own_number` is a
> connection-service operation, not yet a dashboard toggle — do it there when a
> customer opts in at tier-2.

---

## 7. Smoke test

Liveness — the admin SPA shell (there is no dedicated `/health` route):

```bash
curl -sS -o /dev/null -w "%{http_code}\n" https://chuck-re-api.onrender.com/admin   # expect 200
```

Admin session:

```bash
curl -i -X POST https://chuck-re-api.onrender.com/api/admin/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"<seed-email>","password":"<seed-password>"}'      # expect 200 + Set-Cookie: jake_admin_session
```

Status API (internal, master-key header):

```bash
curl -sS https://chuck-re-api.onrender.com/api/ghl/status/locations \
  -H "x-master-api-key: $MASTER_API_KEY"                          # expect {"locations":[...]}
```

Send a test inbound (simulates the GHL automation POSTing an inbound text):

```bash
curl -sS -X POST https://chuck-re-api.onrender.com/api/sms/inbound \
  -H "Content-Type: application/json" \
  -H "x-master-api-key: $MASTER_API_KEY" \
  -d '{
    "contactId": "<gateway-contact-id>",
    "message": "123 Main St, Springfield IL",
    "from": "+15557654321"
  }'                                                              # expect 200 {"ok":true,...}
```

Confirm: a reply SMS lands on the sender's phone and a short status note
("looked up …") appears on the contact. Real send/write only happens because
`ENV_STAGE=staging` (step 2); with it unset you'd see the dev echo line
`🧪 [dev safety] skipped …` in the logs and no reply.

---

## Render specifics

- **Build command:** `npm ci && npm run build-be && npm run build-admin`
- **Start command:** `node dist/server.js` (cwd = repo root, so `/admin` finds
  `client/dist`).
- **Port:** the server binds `process.env.PORT || 8080`; Render injects `PORT`,
  so leave it unset.
- **Migrations (pre-deploy):** set the Render **Pre-Deploy Command** to
  `npx supabase db push --db-url "postgresql://$DB_USER:$DB_PASS@$DB_HOST:$DB_PORT/$DB_DB"`
  so schema changes apply before each build goes live. (This runs in-cluster, so
  the internal `DB_HOST` resolves — no `.ohio-postgres.render.com` suffix. Or run
  it once as a manual one-off.)
- **Redis (optional):** the enrichment webhook + BullMQ worker only mount when
  `UPSTASH_REDIS_TCP_URL` is set. Leave the Upstash trio unset for a
  text-Jake-only bring-up — the server boots fine and logs that it skipped the
  queue. Admin, connections, status, and `/api/sms/inbound` do not need Redis.
