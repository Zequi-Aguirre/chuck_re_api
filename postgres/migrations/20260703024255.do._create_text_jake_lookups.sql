-- JAK-134 — Property lookup cache with a per-phone order index. When a paid
-- /v2/PropertySearch returns a match we snapshot it here, linked to the phone,
-- the requesting conversation message, and the JAK-115 customer. This backs two
-- behaviors:
--   1. the "free re-serve" billing rule — a repeat of the SAME address within
--      the admin-configurable free window is served from this snapshot instead
--      of calling (and charging for) the paid API again; and
--   2. "the Nth address I sent" — `order_index` is a 1-based per-phone counter of
--      resolved addresses, for the JAK-135 orchestrator to reference later.
--
-- `address_key` is the canonical cache key (lower-cased, whitespace-collapsed) so
-- casing/spacing variants of the same address hit the same cache row;
-- `normalized_address` keeps the display form. `property_id` is the provider's
-- record id when present; `property_record` is the FULL verified PropertySearch
-- result (JAK-132 feeds the whole record downstream); `report_text` is the exact
-- SMS we sent, so a free re-serve returns the identical report with no LLM/paid
-- call. `fetched_at` is when the paid data was fetched — the free window is
-- measured against it. No credential lives in this table.

create table if not exists text_jake_lookups (
    id                  uuid          primary key default gen_random_uuid(),
    customer_id         uuid          not null references text_jake_customers (id) on delete cascade,
    phone               text          not null,
    message_id          uuid          references text_jake_conversation_messages (id) on delete set null,
    normalized_address  text          not null,
    address_key         text          not null,
    order_index         integer       not null,
    property_id         text,
    property_record     jsonb         not null,
    report_text         text          not null,
    fetched_at          timestamptz   not null default now(),
    created_at          timestamptz   not null default now()
);

-- Cache-check hot path: latest snapshot for (phone, address_key), newest first.
create index if not exists idx_text_jake_lookups_phone_addr
    on text_jake_lookups (phone, address_key, fetched_at desc, id desc);

-- Per-phone order-index maintenance ("the Nth address"): find the current max.
create index if not exists idx_text_jake_lookups_phone_order
    on text_jake_lookups (phone, order_index desc);
