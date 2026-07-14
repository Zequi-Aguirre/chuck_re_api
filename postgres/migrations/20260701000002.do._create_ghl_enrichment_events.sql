-- JAK-107 — Per-contact enrichment events.
--
-- One row per (location, contact) the enrichment worker has processed. It powers
-- two things at once:
--   1. Idempotency — the worker checks for an existing `enriched` row before it
--      does any work, so a GHL webhook retry / duplicate delivery never
--      double-enriches the same contact.
--   2. Metering — the per-location enrichment log the future usage/billing work
--      (JAK-109) reads. `cost_estimate` is a nullable placeholder now; JAK-109
--      owns real cost accounting.
--
-- The worker UPSERTS on (location_id, contact_id): a first attempt that fails
-- records `failed`, and a later successful reprocess flips the same row to
-- `enriched`. `status`:
--   enriched — write-back succeeded (or ran; off-prod writes are echoed/skipped).
--   skipped  — a permanent, non-error outcome (inactive location, contact gone,
--              no usable address, no property match). Not retried.
--   failed   — an error occurred; `detail` holds a short, SECRET-FREE summary.
--
-- Unlike ghl_custom_fields, this table has NO foreign key to ghl_connections:
-- metering history must outlive a hard connection delete, so location_id is a
-- plain indexed column.
--
-- Column + timestamp naming follows the Automator/Northstar convention:
-- snake_case, timestamptz, created/modified timestamps.

create table if not exists ghl_enrichment_events (
    id             uuid          primary key default gen_random_uuid(),
    -- GHL sub-account (location) the contact belongs to.
    location_id    text          not null,
    -- GHL contact id that was enriched. Unique per location (idempotency key).
    contact_id     text          not null,
    -- enriched | skipped | failed — see file header.
    status         text          not null,
    -- Short, secret-free reason/summary (e.g. "location_inactive", "no property
    -- match", a trimmed error message). Never contains credentials.
    detail         text,
    -- Estimated cost of this enrichment. Placeholder for JAK-109 metering.
    cost_estimate  numeric,
    -- When the contact was successfully enriched; null until status = enriched.
    enriched_at    timestamptz,
    created_at     timestamptz   not null default now(),
    modified_at    timestamptz   not null default now(),
    -- One row per (location, contact) — the idempotency guarantee + upsert target.
    unique (location_id, contact_id)
);

-- Metering reads (JAK-109) scan a single location's events.
create index if not exists ghl_enrichment_events_location_id_idx
    on ghl_enrichment_events (location_id);
