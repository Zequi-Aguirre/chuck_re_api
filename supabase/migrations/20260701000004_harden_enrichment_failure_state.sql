-- JAK-111 — Harden per-record enrichment failure state.
--
-- JAK-107 gave ghl_enrichment_events three outcome statuses (enriched | skipped |
-- failed) and idempotency on (location_id, contact_id). Production failure
-- handling needs two more things persisted per record so nothing is silently
-- lost and a stuck record can be inspected / requeued:
--
--   1. A distinct TERMINAL status — `dead_letter`. `failed` now means "an attempt
--      errored and BullMQ will retry it"; `dead_letter` means "retries are
--      exhausted (or the failure was permanent) — this record is parked for a
--      human to inspect or requeue". Keeping them separate makes the status view
--      (JAK-112) able to distinguish still-retrying from give-up.
--
--   2. `attempt_count` — how many times the worker has processed this record, so
--      a requeue decision has context.
--
--   3. `failed_at` — when the record last errored (mirrors `enriched_at` for the
--      success path), so failures are time-queryable.
--
-- `status` is a free-text column (no CHECK constraint), so the new `dead_letter`
-- value needs no schema change — only the two new columns below. Additive and
-- idempotent (IF NOT EXISTS), safe to run against an existing table.
--
-- Column + timestamp naming follows the Automator/Northstar convention:
-- snake_case, timestamptz, created/modified timestamps.

alter table ghl_enrichment_events
    -- Times the enrichment worker has processed this record (0 until first run).
    add column if not exists attempt_count integer      not null default 0,
    -- When this record last errored; null until status becomes failed/dead_letter.
    add column if not exists failed_at     timestamptz;

-- The status view (JAK-112) and any requeue tooling scan a location's failed /
-- dead-lettered records, most-recently-touched first.
create index if not exists ghl_enrichment_events_location_status_idx
    on ghl_enrichment_events (location_id, status, modified_at desc);
