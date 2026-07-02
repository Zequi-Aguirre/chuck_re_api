-- JAK-102 — Encrypted connection/credential store.
--
-- One row per GHL sub-account (location). This table is the SINGLE source of
-- GHL credentials for BOTH the enrichment webhook path AND text-Jake (JAK-114),
-- replacing the single GHL_API_KEY + GHL_BASE_URL that used to live in Doppler.
--
-- The API key is stored ENCRYPTED at rest (AES-256-GCM, serialized "v1:iv:tag:
-- ciphertext"); the app-level encryption key lives in Doppler (GHL_CREDENTIAL_
-- ENC_KEY), never a tenant key. Column + timestamp naming follows existing
-- snake_case / timestamptz conventions.

create table if not exists ghl_connections (
    id                 uuid          primary key default gen_random_uuid(),
    -- GHL sub-account id; one connection per location.
    location_id        text          not null unique,
    -- Encrypted GHL API key (never plaintext). Serialized cipher string.
    api_key_encrypted  text          not null,
    -- Per-location GHL API base URL.
    base_url           text          not null,
    -- Associated phone number(s), E.164, used to resolve connection for text-Jake.
    phone_numbers      text[]        not null default '{}',
    -- active | inactive — inactive stops processing (uninstall).
    status             text          not null default 'active',
    created_at         timestamptz   not null default now(),
    updated_at         timestamptz   not null default now()
);

-- Resolver support: text-Jake looks up a connection by an associated phone
-- number ($1 = ANY(phone_numbers)). GIN indexes array membership efficiently.
create index if not exists ghl_connections_phone_numbers_idx
    on ghl_connections using gin (phone_numbers);
