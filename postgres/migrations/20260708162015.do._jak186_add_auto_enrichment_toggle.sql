-- JAK-186 — Per-location auto-enrichment enable/disable toggle (epic JAK-180).
--
-- A per-sub-account switch for contact-created auto-enrichment. This closes the
-- TODO(JAK-186) seam the JAK-182 endpoint left: the endpoint now enqueues an
-- enrichment job ONLY when a location is both connected/active AND has this flag
-- turned on.
--
-- Default FALSE — auto-enrichment is OPT-IN. A location must be explicitly turned
-- on (admin toggle) before Jake enriches its new contacts, so connecting a
-- sub-account never silently starts spending REAPI/GHL on every new contact.
--
-- Add-only, idempotent (IF NOT EXISTS) — safe to re-run; never edits an applied
-- migration. Enrichment REAPI lookups still use Jake's GLOBAL REAPI key (Doppler);
-- this ticket adds NO per-location REAPI credential.
alter table ghl_connections
    add column if not exists auto_enrichment_enabled boolean not null default false;
