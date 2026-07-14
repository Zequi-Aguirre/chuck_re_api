-- JAK-191 — Per-sub-account "unlimited credits" flag (epic JAK-180 admin area).
--
-- When ON for a location, the enrichment credit gate treats the account as never
-- insufficient and does NOT decrement its balance — enrichment runs regardless of
-- the numeric balance (the charge is skipped entirely; the ledger stays honest —
-- an unlimited account simply has no debit lines). Enforced in CreditService
-- (hasSufficientCredits / chargeForEnrichment), so every caller respects it.
--
-- Default FALSE — normal prepaid metering is unchanged until an admin turns it on.
-- Add-only + idempotent (IF NOT EXISTS); never edits an applied migration.
alter table ghl_connections
    add column if not exists unlimited_credits boolean not null default false;
