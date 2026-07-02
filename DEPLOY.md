# DEPLOY — Jake staging on Render

Copy-paste runbook to bring up **staging** on Render. Every command, script, env
var, and migration below is real — the npm scripts are in `package.json`, the
migrations in `supabase/migrations/`, and the env vars in
`server/src/main/config/envConfig.ts`. Do it in order.

> **Scope:** staging = a dedicated GHL **test** sub-account, never a customer's
> (SPEC §8). Real GHL writes + outbound SMS fire in staging because
> `ExternalActionGuard.liveActionsAllowed = isProduction || isStaging` — that's
> why `ENV_STAGE=staging` is mandatory (step 2). Without it the server runs as
> dev and silently echo-skips every GHL write/SMS.

---

## 1. Provision Postgres on Render

1. Render Dashboard → **New +** → **PostgreSQL**.
2. Name it (e.g. `jake-staging-db`), pick a region + plan, **Create Database**.
3. Once it's live, open the DB → **Connections** → copy the **External Database
   URL** (`postgres://user:pass@host/dbname`). This is your `DATABASE_URL`.
   - Use the **Internal** URL for the web service if the DB and service share a
     region (faster, no egress); use the **External** URL when running migrations
     from your laptop.

The schema is created by the migrations in step 3 — the DB starts empty.

---

## 2. Doppler / Render env vars

Set these on the Render web service (or in your `stg` Doppler config synced to
Render). Each is read in `server/src/main/config/envConfig.ts`.

| Var | Purpose |
|---|---|
| `DATABASE_URL` | Render Postgres connection string. Backs the connection/credential store, admin users, credit ledger, and enrichment metering. |
| `JWT_SECRET` | Signs admin-dashboard session JWTs (`AdminAuthService.issueToken` throws without it). Use any long random string. |
| `GHL_CREDENTIAL_ENC_KEY` | App-level secret that encrypts each tenant's GHL API key at rest (AES-256-GCM, key = SHA-256 of this value). Generate: `openssl rand -base64 32`. Any strong value works — it's hashed to 32 bytes. |
| `JAKE_GATEWAY_GHL_API_KEY` | Master gateway key for Zequi's one shared "Jake" GHL sub-account — the default `gateway` text mode. App-level only, **never** stored in the DB. |
| `JAKE_GATEWAY_LOCATION_ID` | The gateway sub-account's GHL location id. |
| `JAKE_GATEWAY_BASE_URL` | GHL API base URL for the gateway client (e.g. `https://services.leadconnectorhq.com`). |
| `ADMIN_SEED_EMAIL` | First-admin bootstrap email. Seeded once at boot, then unset (step 4). |
| `ADMIN_SEED_PASSWORD` | First-admin bootstrap password. Bcrypt-hashed at boot; never stored plaintext. Unset after first boot. |
| `CREDIT_COST_TEXT_LOOKUP` | *(optional)* Credits charged per text-Jake property lookup. Defaults to `1` if unset. |

**Also required** (not in the headline list, but the server/smoke test need them):

| Var | Purpose |
|---|---|
| `ENV_STAGE=staging` | Flips on real external actions (see the callout above). **Mandatory for staging** or every GHL write/SMS is skipped. |
| `MASTER_API_KEY` | Internal header secret guarding `POST /api/sms/inbound` and `GET /api/ghl/status/*`. Any long random string; used in the smoke test (step 7). |

Generate the secrets:

```bash
openssl rand -base64 32   # GHL_CREDENTIAL_ENC_KEY
openssl rand -hex 32      # JWT_SECRET
openssl rand -hex 32      # MASTER_API_KEY
```

---

## 3. Run migrations

Migrations live in `supabase/migrations/` and apply in timestamp order (they
create `ghl_connections`, `ghl_custom_fields`, `ghl_enrichment_events`,
`credit_ledger`, `admin_users`, `text_jake_customers`, and the `text_mode`
column). Point the Supabase CLI at the Render DB:

```bash
npx supabase db push --db-url "$DATABASE_URL"
```

> The repo's `npm run dev-db-migrate` is the same `supabase db push` wrapped in
> `doppler run -p jake -c dev` for local dev. For staging, target the Render DB
> directly with `--db-url` as above.

---

## 4. Build + boot

From the repo root (cwd must be the repo root so `client/dist` resolves at
`/admin`):

```bash
npm ci
npm run build-be      # tsc + bundle -> dist/server.js
npm run build-admin   # vite build client -> client/dist (served at /admin)
node dist/server.js   # boot (Render start command; PORT is injected by Render)
```

On **first** boot with `ADMIN_SEED_EMAIL` + `ADMIN_SEED_PASSWORD` set, the server
creates the first admin and logs:

```
🔐 First admin user created from ADMIN_SEED_* env.
```

Then **unset `ADMIN_SEED_EMAIL` and `ADMIN_SEED_PASSWORD`** in Render and
redeploy. Re-seeding is idempotent (it no-ops once the admin exists and never
overwrites the password), but leaving the seed password in the environment is
needless exposure. Rotate the password through the app, not by re-seeding.

> Local equivalent of the boot line (uses Doppler dev config):
> `npm start` → `doppler run -p jake -c dev -- node dist/server.js`.

---

## 5. Log in + onboard the first sub-account

1. Open `https://<your-render-host>/admin` and log in with the seeded
   email/password (`POST /api/admin/auth/login` sets an httpOnly session cookie).
2. Connect the first sub-account. In the dashboard this is the "connect a
   sub-account (paste key)" action → `POST /api/admin/connections`:

```bash
curl -X POST https://<host>/api/admin/connections \
  -H "Content-Type: application/json" \
  --cookie "jake_admin_session=<session-cookie-from-login>" \
  -d '{
    "locationId": "<ghl-location-id>",
    "apiKey": "<the-tenant-GHL-api-key>",
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
  Zequi's one shared "Jake" GHL sub-account using the **master gateway key**
  (`JAKE_GATEWAY_*`, app-level, never in the DB). Zequi's number, Zequi pays SMS.
  New connections created in the dashboard start here.
- **`own_number` (OPT-IN, tier-2).** Text-Jake runs **inside the customer's own**
  GHL sub-account using their **encrypted per-tenant key** (the pasted key from
  step 5) + a number they assign to Jake. SMS cost shifts to the customer. This
  is the JAK-114 per-tenant routing.

> Note: the admin create/update API sets no `text_mode`, so every dashboard-onboarded
> connection defaults to `gateway`. Flipping a connection to `own_number` is a
> connection-service operation, not yet a dashboard toggle — do it there when a
> customer opts in at tier-2.

---

## 7. Verify it works (smoke)

Liveness — the admin SPA shell (there is no dedicated `/health` route):

```bash
curl -sS -o /dev/null -w "%{http_code}\n" https://<host>/admin   # expect 200
```

Admin session:

```bash
curl -i -X POST https://<host>/api/admin/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"<seed-email>","password":"<seed-password>"}'      # expect 200 + Set-Cookie
```

Status API (internal, master-key header):

```bash
curl -sS https://<host>/api/ghl/status/locations \
  -H "x-master-api-key: $MASTER_API_KEY"                          # expect {"locations":[...]}
```

Send a test inbound (simulates the GHL automation POSTing an inbound text):

```bash
curl -sS -X POST https://<host>/api/sms/inbound \
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
  so leave it unset and don't hardcode a port.
- **Migrations (pre-deploy):** set the Render **Pre-Deploy Command** to
  `npx supabase db push --db-url "$DATABASE_URL"` so schema changes apply before
  each new build goes live. (Or run it once as a manual one-off job.)
- **Redis (optional):** the enrichment webhook + BullMQ worker only mount when
  `UPSTASH_REDIS_TCP_URL` is set. Leave it unset for a text-Jake-only staging
  bring-up — the server boots fine and logs that it skipped the queue. Admin,
  connections, status, and `/api/sms/inbound` do not need Redis.
