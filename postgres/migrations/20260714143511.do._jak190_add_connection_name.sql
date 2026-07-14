-- JAK-190 — Friendly name per GHL sub-account (epic JAK-180 admin area).
--
-- The admin dashboard only shows the raw GHL location id, which is meaningless to
-- read. This adds an OPTIONAL friendly label the admin sets/edits; the UI shows it
-- as the primary heading and falls back to the location id when empty.
--
-- Nullable, NO backfill needed — an empty/absent name simply displays as the
-- location id (today's behavior). Add-only + idempotent (IF NOT EXISTS); never
-- edits an applied migration.
alter table ghl_connections
    add column if not exists name text;
