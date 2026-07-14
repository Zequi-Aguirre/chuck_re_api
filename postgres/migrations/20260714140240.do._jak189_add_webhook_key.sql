-- JAK-189 — Per-sub-account inbound webhook API key (epic JAK-180).
--
-- Each GHL sub-account (connection) gets its OWN key that authenticates
-- POST /ghl/contact-created, replacing the shared MASTER_API_KEY. A leaked key
-- then only exposes that ONE sub-account.
--
-- Stored the API-key way (mirrors `api_key_encrypted`, JAK-102):
--   webhook_key_hash — SHA-256 (hex) of the key, UNIQUE + indexed, for O(1)
--                      inbound lookup (resolve the location BY the presented key).
--   webhook_key_enc  — the key AES-256-GCM encrypted (same cipher as api_key) so
--                      the admin UI can display/copy it for the sub-account owner.
--
-- Both columns are NULLABLE here on purpose: the actual key VALUE is generated +
-- encrypted with the app-level Doppler cipher (GHL_CREDENTIAL_ENC_KEY), which SQL
-- cannot reproduce. So the migration owns the SCHEMA; the BACKFILL of existing
-- rows is a one-time, idempotent app step (GhlConnectionService.ensureWebhookKeys,
-- run at boot) that generates a key for every connection missing one — active AND
-- inactive — so no current sub-account is left keyless. New connections get a key
-- at create time.
--
-- Add-only + idempotent (IF NOT EXISTS); never edits an applied migration.

alter table ghl_connections
    add column if not exists webhook_key_hash text,
    add column if not exists webhook_key_enc  text;

-- Unique so a presented key resolves at most one location; Postgres treats NULLs
-- as distinct, so rows awaiting backfill (NULL hash) don't collide.
create unique index if not exists ghl_connections_webhook_key_hash_idx
    on ghl_connections (webhook_key_hash);
