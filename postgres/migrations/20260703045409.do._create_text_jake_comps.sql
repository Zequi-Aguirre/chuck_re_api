-- JAK-137 — Comps specialist persistence: the comps cache (for the free re-serve
-- rule) and the ONE pending confirm-before-spend offer per phone.
--
-- text_jake_comps mirrors the JAK-136 text_jake_skip_traces cache: when a PAID
-- /v3/PropertyComps returns comparable sales we snapshot the result here, linked
-- to the phone, the requesting conversation message, and the JAK-115 customer. A
-- repeat comps request for the SAME target AND the SAME parameter-set within the
-- admin-configurable free window (free_reserve_window_days, reused from JAK-134)
-- is served from this snapshot instead of calling (and charging for) the API
-- again. Because comps depend on parameters (radius, count, timeframe, bed/bath/
-- sqft tolerance), the cache key folds the parameter-set into `target_key`
-- (canonical, lower-cased, whitespace-collapsed address + a stable params
-- signature) so a DIFFERENT parameter-set is a new request, not a cache hit;
-- `params` keeps the resolved parameter-set that produced the snapshot.
-- `normalized_target` keeps the display address; `comps_record` is the FULL
-- verified /v3/PropertyComps response; `report_text` is the exact SMS we sent, so
-- a free re-serve returns the identical reply with no LLM/paid call. `fetched_at`
-- is when the paid data was fetched — the free window is measured against it. No
-- credential lives here.
create table if not exists text_jake_comps (
    id                  uuid          primary key default gen_random_uuid(),
    customer_id         uuid          not null references text_jake_customers (id) on delete cascade,
    phone               text          not null,
    message_id          uuid          references text_jake_conversation_messages (id) on delete set null,
    normalized_target   text          not null,
    target_key          text          not null,
    params              jsonb         not null,
    comps_record        jsonb         not null,
    report_text         text          not null,
    fetched_at          timestamptz   not null default now(),
    created_at          timestamptz   not null default now()
);

-- Cache-check hot path: latest snapshot for (phone, target_key), newest first.
-- target_key already folds in the parameter signature, so this keys per param-set.
create index if not exists idx_text_jake_comps_phone_target
    on text_jake_comps (phone, target_key, fetched_at desc, id desc);

-- text_jake_comps_pending — the single outstanding "reply OK to run it" comps
-- offer per phone. Because a comps pull costs more than a report, we NEVER spend
-- on the first ask: we quote the price + the parameters, store this row, and
-- consume it when the texter confirms with OK/YES (the freshness TTL lives in the
-- service). One row per phone (phone is the PK), upserted, so a new offer always
-- replaces any prior one. `credits` captures the quoted cost and `params` the
-- resolved parameter-set, so neither the price nor the parameters can drift
-- between the quote and the confirmation. No credential lives here.
create table if not exists text_jake_comps_pending (
    phone         text          primary key,
    customer_id   uuid          not null references text_jake_customers (id) on delete cascade,
    target        text          not null,
    params        jsonb         not null,
    credits       integer       not null,
    created_at    timestamptz   not null default now()
);
