-- JAK-105 — Provisioned custom fields per location.
--
-- One row per canonical Jake custom field we auto-create in a GHL sub-account on
-- install. The enrichment worker (JAK-107) writes back to `ghl_field_id`, so
-- this table is the map from a stable Jake field key → the GHL field id in that
-- specific location. It exists because GHL assigns a DIFFERENT field id per
-- location, so write-back can't hardcode ids.
--
-- Idempotency: (location_id, jake_field_key) is unique, so a re-install can look
-- up what it already provisioned and never duplicate a field.
--
-- Column + timestamp naming follows the Automator/Northstar convention:
-- snake_case, timestamptz, created/modified/deleted timestamps (deleted_at is a
-- nullable soft-delete marker; reads filter it out).

create table if not exists ghl_custom_fields (
    id               uuid          primary key default gen_random_uuid(),
    -- GHL sub-account (location) this field was provisioned in.
    location_id      text          not null
                                   references ghl_connections (location_id)
                                   on delete cascade,
    -- Stable Jake field key from the canonical catalog (e.g. jake_owner_name).
    -- Idempotency + write-back target: constant across every location.
    jake_field_key   text          not null,
    -- The GHL-assigned custom field id — the actual write-back target (JAK-107).
    ghl_field_id     text          not null,
    -- The GHL field key as GHL stored it (e.g. contact.jake_owner_name). Kept so
    -- a re-install can adopt a field created out-of-band by matching on key.
    ghl_field_key    text,
    -- Human-readable field name shown in the GHL UI.
    name             text          not null,
    -- GHL data type provisioned (TEXT, LARGE_TEXT, MONETORY, CHECKBOX, DATE…).
    data_type        text          not null,
    created_at       timestamptz   not null default now(),
    modified_at      timestamptz   not null default now(),
    deleted_at       timestamptz,
    -- One row per (location, canonical key) — the idempotency guarantee.
    unique (location_id, jake_field_key)
);

-- Write-back path (JAK-107) loads every provisioned field for a location.
create index if not exists ghl_custom_fields_location_id_idx
    on ghl_custom_fields (location_id);
