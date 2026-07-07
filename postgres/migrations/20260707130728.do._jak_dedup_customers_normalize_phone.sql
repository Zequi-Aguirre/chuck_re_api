-- JAK-dedup-customers — Canonicalize text-Jake customer phones to E.164 and merge
-- existing duplicate rows.
--
-- ROOT CAUSE: a text customer is keyed by their sender phone (JAK-115), stored as
-- the literal string. Two code paths persisted that number in two shapes — the
-- gateway/billing path stored GHL's E.164 ("+14845076216"), the admin dashboard
-- stored whatever an admin typed ("(484)507-6216"). Same human, two rows: one
-- NAMED (name/email), one UNNAMED duplicate. The app-side fix normalizes every
-- create + lookup to one canonical E.164 key (see phoneNormalization.ts); this
-- migration cleans up the rows already written under the old behavior.
--
-- WHAT IT DOES, per set of rows that canonicalize to the SAME E.164:
--   1. pick ONE row to KEEP — prefer a LIVE row, then a NAMED one (name/email),
--      then the oldest — so the named identity survives;
--   2. RE-POINT every child record off the duplicate onto the kept row so NOTHING
--      is lost: conversation messages, property lookups, skip-trace + comps caches
--      (customer_id FK, plus their denormalized `phone`), the per-phone pending
--      offers/questions, and the credit ledger;
--   3. CREDIT-MERGE RULE: the kept account's balance in EACH bucket (report /
--      skiptrace / comps) becomes the SUM of the kept + all duplicate balances,
--      and every ledger row is re-pointed to the kept account — so the full audit
--      trail is preserved and no granted credit is lost;
--   4. DELETE the duplicate customer row (children already re-pointed, so the
--      ON DELETE CASCADE has nothing left to take);
--   5. rewrite every surviving customer's `phone` to its canonical E.164.
--
-- The canonical expression below MIRRORS normalizePhone() in phoneNormalization.ts
-- exactly. Re-runnable: a second pass finds no duplicates and is a no-op.
--
-- NOTE the credit tables (credit_ledger / credit_balances) key on `location_id`,
-- which for a text customer is the customer id AS TEXT — so every join to them
-- casts the uuid id to text.

-- 1) Map every customer row to its canonical phone and its kept-row target.
drop table if exists _tjc_dedup;
create temporary table _tjc_dedup as
with digits as (
    select id, first_name, last_name, email, phone, deleted_at, created_at,
           regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g') as dg
    from text_jake_customers
),
canon as (
    select *,
        case
            when length(dg) = 11 and left(dg, 1) = '1' then '+' || dg
            when length(dg) = 10 then '+1' || dg
            when length(dg) > 0 then '+' || dg
            else regexp_replace(coalesce(phone, ''), '\s', '', 'g')
        end as cphone
    from digits
),
ranked as (
    select id, cphone,
        first_value(id) over (
            partition by cphone
            order by
                (case when deleted_at is null then 0 else 1 end),           -- live first
                (case when coalesce(first_name, '') <> ''
                        or coalesce(last_name, '') <> ''
                        or coalesce(email, '') <> '' then 0 else 1 end),     -- named first
                created_at asc, id asc
        ) as keep_id
    from canon
)
select id as dup_id, keep_id, cphone from ranked;

-- 2) Re-point the FK-cascade children off each duplicate onto the kept customer,
--    then rewrite their denormalized `phone` to the canonical value (covers kept +
--    singleton rows too, since every id self-maps in _tjc_dedup).
update text_jake_conversation_messages t set customer_id = d.keep_id
    from _tjc_dedup d where t.customer_id = d.dup_id and d.dup_id <> d.keep_id;
update text_jake_conversation_messages t set phone = d.cphone
    from _tjc_dedup d where t.customer_id = d.dup_id and t.phone <> d.cphone;

update text_jake_lookups t set customer_id = d.keep_id
    from _tjc_dedup d where t.customer_id = d.dup_id and d.dup_id <> d.keep_id;
update text_jake_lookups t set phone = d.cphone
    from _tjc_dedup d where t.customer_id = d.dup_id and t.phone <> d.cphone;

update text_jake_skip_traces t set customer_id = d.keep_id
    from _tjc_dedup d where t.customer_id = d.dup_id and d.dup_id <> d.keep_id;
update text_jake_skip_traces t set phone = d.cphone
    from _tjc_dedup d where t.customer_id = d.dup_id and t.phone <> d.cphone;

update text_jake_comps t set customer_id = d.keep_id
    from _tjc_dedup d where t.customer_id = d.dup_id and d.dup_id <> d.keep_id;
update text_jake_comps t set phone = d.cphone
    from _tjc_dedup d where t.customer_id = d.dup_id and t.phone <> d.cphone;

-- 3) Pending state is keyed by `phone` (PK, one row per phone) and is transient
--    confirm-before-spend/disambiguation state with its own TTL. Two duplicates
--    could each hold a pending row, which would collide on the canonical phone —
--    so keep the NEWEST per canonical phone and drop the rest, then re-point the
--    survivor onto the kept customer + canonical phone.
delete from text_jake_skip_trace_pending p using _tjc_dedup d
    where p.customer_id = d.dup_id and exists (
        select 1 from text_jake_skip_trace_pending p2
        join _tjc_dedup d2 on p2.customer_id = d2.dup_id
        where d2.keep_id = d.keep_id
          and (p2.created_at, p2.customer_id) > (p.created_at, p.customer_id)
    );
update text_jake_skip_trace_pending p set customer_id = d.keep_id, phone = d.cphone
    from _tjc_dedup d where p.customer_id = d.dup_id;

delete from text_jake_comps_pending p using _tjc_dedup d
    where p.customer_id = d.dup_id and exists (
        select 1 from text_jake_comps_pending p2
        join _tjc_dedup d2 on p2.customer_id = d2.dup_id
        where d2.keep_id = d.keep_id
          and (p2.created_at, p2.customer_id) > (p.created_at, p.customer_id)
    );
update text_jake_comps_pending p set customer_id = d.keep_id, phone = d.cphone
    from _tjc_dedup d where p.customer_id = d.dup_id;

delete from text_jake_pending_disambiguation p using _tjc_dedup d
    where p.customer_id = d.dup_id and exists (
        select 1 from text_jake_pending_disambiguation p2
        join _tjc_dedup d2 on p2.customer_id = d2.dup_id
        where d2.keep_id = d.keep_id
          and (p2.created_at, p2.customer_id) > (p.created_at, p.customer_id)
    );
update text_jake_pending_disambiguation p set customer_id = d.keep_id, phone = d.cphone
    from _tjc_dedup d where p.customer_id = d.dup_id;

-- 4) Credit-merge. Re-point every ledger entry (preserving the full audit trail),
--    then fold each duplicate's per-bucket balance into the kept account (SUM) and
--    drop the duplicate's balance rows. location_id = customer id AS TEXT.
update credit_ledger l set location_id = d.keep_id::text
    from _tjc_dedup d
    where l.location_id = d.dup_id::text and d.dup_id <> d.keep_id;

insert into credit_balances (location_id, credit_type, balance)
select d.keep_id::text, b.credit_type, sum(b.balance)
from credit_balances b
join _tjc_dedup d on b.location_id = d.dup_id::text
where d.dup_id <> d.keep_id
group by d.keep_id::text, b.credit_type
on conflict (location_id, credit_type) do update
    set balance = credit_balances.balance + excluded.balance,
        modified_at = now();

delete from credit_balances b using _tjc_dedup d
    where b.location_id = d.dup_id::text and d.dup_id <> d.keep_id;

-- 5) Delete the duplicate customer rows (all children already re-pointed).
delete from text_jake_customers c using _tjc_dedup d
    where c.id = d.dup_id and d.dup_id <> d.keep_id;

-- 6) Canonicalize the phone on every surviving customer (kept + singleton rows).
update text_jake_customers c set phone = d.cphone, modified_at = now()
    from _tjc_dedup d
    where c.id = d.dup_id and d.dup_id = d.keep_id and c.phone <> d.cphone;

drop table if exists _tjc_dedup;

-- 7) Guarantee the UNIQUE(phone) constraint that keeps future duplicates out. The
--    table was created with `phone text not null unique`, so this is normally a
--    no-op; the guard makes the migration self-healing if that constraint ever
--    drifted. Combined with the app-side normalizer, every write now lands a
--    canonical E.164 value into this one unique column.
do $$
begin
    if not exists (
        select 1 from pg_constraint
        where conrelid = 'text_jake_customers'::regclass
          and contype = 'u'
          and pg_get_constraintdef(oid) like '%(phone)%'
    ) then
        alter table text_jake_customers
            add constraint text_jake_customers_phone_key unique (phone);
    end if;
end $$;
