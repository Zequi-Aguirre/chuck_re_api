-- JAK-monthly-credit-restore — monthly credit RESTORE anchored to signup date.
--
-- A scheduled worker restores each text customer's three credit buckets back to
-- the effective admin-editable default once a month, on the anniversary of their
-- signup (created_at). This migration adds the per-customer clock that drives it:
-- `next_reset_at`, the timestamp of the customer's NEXT due restore.
--
-- Two concerns, one column:
--
-- 1) FUTURE customers — the column default is `now() + interval '1 month'`.
--    Because `created_at` also defaults to `now()`, at insert time this equals
--    `created_at + 1 month`, so every passive first-contact upsert and every admin
--    create anchors the first restore to signup with NO code change to those
--    insert paths (the DB is the single source of truth for the default).
--
-- 2) EXISTING customers — a plain ADD COLUMN ... DEFAULT would stamp EVERY legacy
--    row with the SAME `now() + 1 month`, firing a synchronized reset flood a
--    month after deploy. Instead we BACKFILL each existing row to the next
--    signup-anniversary boundary that is STRICTLY IN THE FUTURE:
--
--        created_at + N months, where N is the smallest whole-month count that
--        pushes the boundary past now().
--
--    Rule / rationale: `age(now(), created_at)` gives the elapsed interval; its
--    whole-month component is the number of complete monthly anniversaries that
--    have already passed, so `created_at + (that + 1) months` is the FIRST
--    anniversary still ahead. This means:
--      - a customer created 5 days ago gets created_at + 1 month;
--      - a customer created 14 months ago gets created_at + 15 months (their next
--        anniversary), NOT an immediate reset;
--    so NOBODY is due on the worker's first run — the earliest possible
--    `next_reset_at` is up to one month out. `make_interval(months => ...)` keeps
--    the boundary on the signup day-of-month and clamps short months correctly
--    (e.g. Jan 31 + 1 month -> Feb 28). The worker advances the column the same
--    way, so the anchor never drifts off the signup day.

-- Add nullable first so the backfill can compute each row's own anchor before we
-- lock in the default + NOT NULL for future inserts.
alter table text_jake_customers
    add column if not exists next_reset_at timestamptz;

-- Backfill existing rows to their next FUTURE signup-anniversary boundary.
update text_jake_customers
set next_reset_at = created_at + make_interval(months =>
        (extract(year  from age(now(), created_at))::int * 12
       + extract(month from age(now(), created_at))::int) + 1)
where next_reset_at is null;

-- Future inserts anchor to signup (created_at == now() at insert), and the column
-- is now mandatory. Set the default BEFORE NOT NULL so any concurrent insert in
-- this transaction is covered.
alter table text_jake_customers
    alter column next_reset_at set default (now() + interval '1 month');

alter table text_jake_customers
    alter column next_reset_at set not null;

-- The worker's due-scan filters on `next_reset_at <= now()` over live customers;
-- a partial index keeps that sweep off a full-table scan as the customer base grows.
create index if not exists text_jake_customers_next_reset_at_idx
    on text_jake_customers (next_reset_at)
    where deleted_at is null;
