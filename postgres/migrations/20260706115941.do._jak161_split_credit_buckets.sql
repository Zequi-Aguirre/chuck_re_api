-- JAK-161 — Split the single Jake credit pool into THREE per-feature buckets.
--
-- Text-Jake billing (JAK-109) kept ONE prepaid balance per credit account
-- (customer id). Monetization now needs three INDEPENDENT balances per customer:
--
--   report    — property report (freely granted, still gated).
--   skiptrace — PAID.
--   comps     — PAID.
--
-- Each specialist checks + charges ONLY its own bucket; running out of comps
-- credits can NEVER block a report or a skip trace. We add a `credit_type`
-- dimension to the ledger + balance tables (keeping the append-only audit trail),
-- migrate every existing single balance into the REPORT bucket, grant the new
-- defaults (10 skip-trace, 10 comps) to existing customers, and seed the
-- admin-editable new-customer defaults + out-of-credits messages into app_settings
-- (JAK-162 builds the UI on top of these).
--
-- GHL-location enrichment (JAK-107) also rides these tables; it only ever uses the
-- REPORT bucket (the column default), so its single-pool behavior is unchanged.
--
-- Written to be re-runnable (idempotent) end-to-end: column adds are IF NOT
-- EXISTS, the primary-key swap is guarded, data grants use ON CONFLICT DO NOTHING
-- / NOT EXISTS. Whole credits (integer) throughout.

-- 1) The feature/type dimension. Default 'report' so every pre-existing row —
--    ledger entries AND the maintained balances — rolls into the REPORT bucket.
alter table credit_ledger
    add column if not exists credit_type text not null default 'report';

alter table credit_balances
    add column if not exists credit_type text not null default 'report';

-- 2) The maintained balance is now keyed by (location_id, credit_type): one row
--    per account PER bucket. Swap the single-column primary key for the composite
--    one, guarded so a re-run is a no-op.
do $$
begin
    if exists (
        select 1 from pg_constraint
        where conname = 'credit_balances_pkey'
          and conrelid = 'credit_balances'::regclass
          and pg_get_constraintdef(oid) = 'PRIMARY KEY (location_id)'
    ) then
        alter table credit_balances drop constraint credit_balances_pkey;
        alter table credit_balances add primary key (location_id, credit_type);
    end if;
end $$;

-- Recent-activity + status reads scan one account's ledger newest-first; keep an
-- index that also carries credit_type so a per-bucket history stays a cheap scan.
create index if not exists credit_ledger_location_id_type_created_at_idx
    on credit_ledger (location_id, credit_type, created_at desc);

-- 3) Admin-editable NEW-CUSTOMER defaults (app_settings, same KV pattern as the
--    editable prompts + costs). On customer creation the three balances are seeded
--    from these. Code defaults in CreditSettingsService MIRROR these seeds.
insert into app_settings (key, value) values
    ('default_report_credits',    '100'),
    ('default_skiptrace_credits', '10'),
    ('default_comps_credits',     '10')
on conflict (key) do nothing;

-- 3b) Admin-editable OUT-OF-CREDITS messages, one per feature. Emoji-free; the
--     canonical JAK-158 SMS footer is appended by the sender (NOT stored here, so
--     it can never be edited away). No self-serve checkout — the copy points the
--     texter at an admin; a website link can be added later by editing the message.
insert into app_settings (key, value) values
    ('out_of_credits_message_report',    'You''re out of report credits. To get more, contact an admin.'),
    ('out_of_credits_message_skiptrace', 'You''re out of skip-trace credits. To get more, contact an admin.'),
    ('out_of_credits_message_comps',     'You''re out of comps credits. To get more, contact an admin.')
on conflict (key) do nothing;

-- 4) Migrate existing customers. Their current single balance already became the
--    REPORT bucket via the column default in step 1. Now grant every existing
--    text-Jake customer the new paid-feature defaults: 10 skip-trace + 10 comps.
--    Balance rows use ON CONFLICT DO NOTHING; the matching audit ledger rows are
--    guarded by NOT EXISTS — so a re-run never double-grants.
-- The credit account key is the customer id stored as text (credit_ledger /
-- credit_balances.location_id are text; text_jake_customers.id is uuid), so cast
-- the id to text everywhere it meets the ledger's location_id.
insert into credit_balances (location_id, credit_type, balance)
select id::text, 'skiptrace', 10 from text_jake_customers
on conflict (location_id, credit_type) do nothing;

insert into credit_balances (location_id, credit_type, balance)
select id::text, 'comps', 10 from text_jake_customers
on conflict (location_id, credit_type) do nothing;

insert into credit_ledger (location_id, amount, balance_after, reason, credit_type)
select c.id::text, 10, 10, 'manual_grant', 'skiptrace'
from text_jake_customers c
where not exists (
    select 1 from credit_ledger l
    where l.location_id = c.id::text and l.credit_type = 'skiptrace'
);

insert into credit_ledger (location_id, amount, balance_after, reason, credit_type)
select c.id::text, 10, 10, 'manual_grant', 'comps'
from text_jake_customers c
where not exists (
    select 1 from credit_ledger l
    where l.location_id = c.id::text and l.credit_type = 'comps'
);
