-- JAK-109 — Credit metering: the ledger + the maintained balance.
--
-- The enrichment app runs on a prepaid credit system (billing/Stripe top-ups are
-- deferred — for beta, credits are GRANTED MANUALLY). Two tables:
--
--   credit_ledger    — the append-only source of truth. ONE row per debit or
--                      credit: a signed `amount` (negative = charge, positive =
--                      grant/refund), the `reason` it happened, and the record it
--                      refers to (`contact_id` for an enrichment charge; null for
--                      a manual grant). `balance_after` snapshots the running
--                      balance so history is auditable AND the balance is fully
--                      reconstructable by replaying the ledger.
--
--   credit_balances  — the maintained per-location balance, kept consistent with
--                      the ledger inside the SAME transaction (see
--                      CreditLedgerStore). It exists so the worker can check
--                      "enough credits?" and deduct atomically (SELECT ... FOR
--                      UPDATE) without summing the whole ledger on the hot path.
--
-- Balances/costs are whole credits (integer). Like ghl_enrichment_events, these
-- tables carry NO foreign key to ghl_connections: billing history must outlive a
-- hard connection delete, so location_id is a plain indexed column.
--
-- Column + timestamp naming follows the Automator/Northstar convention:
-- snake_case, timestamptz, created/modified/deleted timestamps (deleted_at is a
-- nullable soft-delete marker so a ledger row can be voided without a hard
-- delete; reads filter it out).

create table if not exists credit_ledger (
    id             uuid          primary key default gen_random_uuid(),
    -- GHL sub-account (location/tenant) this entry belongs to.
    location_id    text          not null,
    -- Signed credit delta: negative = debit (charge), positive = credit (grant /
    -- refund / adjustment). Never zero.
    amount         integer       not null,
    -- The location's balance immediately AFTER applying this entry — an audit
    -- snapshot that lets history be reconstructed and reconciled.
    balance_after  integer       not null,
    -- Why this entry exists: enrichment | skip_trace | manual_grant | adjustment.
    reason         text          not null,
    -- The record this entry refers to (the enriched GHL contact) for charges;
    -- null for account-level entries like a manual grant.
    contact_id     text,
    created_at     timestamptz   not null default now(),
    modified_at    timestamptz   not null default now(),
    deleted_at     timestamptz
);

-- The balance/status read (JAK-112) and the "recent activity" list both scan a
-- single location's ledger, newest first.
create index if not exists credit_ledger_location_id_created_at_idx
    on credit_ledger (location_id, created_at desc);

create table if not exists credit_balances (
    -- One row per location; the location id IS the key.
    location_id    text          primary key,
    -- Current spendable credit balance. Kept consistent with credit_ledger in
    -- the same transaction. Non-negative (charges refuse to overdraw).
    balance        integer       not null default 0,
    created_at     timestamptz   not null default now(),
    modified_at    timestamptz   not null default now()
);
