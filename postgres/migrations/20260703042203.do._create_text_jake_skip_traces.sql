-- JAK-136 — Skip-trace specialist persistence: the trace cache (for the free
-- re-serve rule) and the ONE pending confirm-before-spend offer per phone.
--
-- text_jake_skip_traces mirrors the JAK-134 text_jake_lookups cache: when a PAID
-- /v2/SkipTrace returns owner/contact info we snapshot it here, linked to the
-- phone, the requesting conversation message, and the JAK-115 customer. A repeat
-- trace of the SAME target within the admin-configurable free window
-- (free_reserve_window_days, reused from JAK-134) is served from this snapshot
-- instead of calling (and charging for) the API again. `target_key` is the
-- canonical cache key (lower-cased, whitespace-collapsed); `normalized_target`
-- keeps the display form; `trace_record` is the FULL verified /v2/SkipTrace
-- record; `report_text` is the exact SMS we sent, so a free re-serve returns the
-- identical reply with no LLM/paid call. `fetched_at` is when the paid data was
-- fetched — the free window is measured against it. No credential lives here.
create table if not exists text_jake_skip_traces (
    id                  uuid          primary key default gen_random_uuid(),
    customer_id         uuid          not null references text_jake_customers (id) on delete cascade,
    phone               text          not null,
    message_id          uuid          references text_jake_conversation_messages (id) on delete set null,
    normalized_target   text          not null,
    target_key          text          not null,
    trace_record        jsonb         not null,
    report_text         text          not null,
    fetched_at          timestamptz   not null default now(),
    created_at          timestamptz   not null default now()
);

-- Cache-check hot path: latest snapshot for (phone, target_key), newest first.
create index if not exists idx_text_jake_skip_traces_phone_target
    on text_jake_skip_traces (phone, target_key, fetched_at desc, id desc);

-- text_jake_skip_trace_pending — the single outstanding "reply OK to run it"
-- skip-trace offer per phone. Because a skip trace costs more than a report, we
-- NEVER spend on the first ask: we quote the price, store this row, and consume
-- it when the texter confirms with OK/YES (the freshness TTL lives in the
-- service). One row per phone (phone is the PK), upserted, so a new offer always
-- replaces any prior one. `credits` captures the quoted cost so the price can't
-- drift between the quote and the confirmation. No credential lives here.
create table if not exists text_jake_skip_trace_pending (
    phone         text          primary key,
    customer_id   uuid          not null references text_jake_customers (id) on delete cascade,
    target        text          not null,
    credits       integer       not null,
    created_at    timestamptz   not null default now()
);
