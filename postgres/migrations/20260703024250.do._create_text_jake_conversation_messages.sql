-- JAK-134 — Per-phone conversation memory (FOUNDATION of the Conversational
-- Text-Jake epic). An ordered, append-only log of every inbound (and the
-- outbound replies we send) for a texting customer, keyed by their phone. A
-- later ticket (JAK-135 orchestrator) reads the recent window to resolve
-- references like "the 2nd address I sent".
--
-- One row per message. `customer_id` links to the JAK-115 billing identity
-- (text_jake_customers); `phone` is denormalized so the history can be read by
-- phone directly. `direction` is 'inbound' | 'outbound'. `resolved_address` is
-- the normalized address we parsed from the message (null when it wasn't an
-- address). `tenant_location_id` / `text_mode` capture the resolved route
-- (own_number location vs shared gateway) at the time the message was handled.
--
-- Ordering: created_at (then id) — mirrors the credit_ledger recent-entries
-- convention. No credential lives in this table. Follows the house snake_case /
-- timestamptz convention; shares the one Postgres pool.

create table if not exists text_jake_conversation_messages (
    id                  uuid          primary key default gen_random_uuid(),
    customer_id         uuid          not null references text_jake_customers (id) on delete cascade,
    phone               text          not null,
    direction           text          not null check (direction in ('inbound', 'outbound')),
    body                text          not null,
    resolved_address    text,
    tenant_location_id  text,
    text_mode           text,
    created_at          timestamptz   not null default now()
);

-- The hot read path is "recent messages for this phone, newest first" and
-- "the last inbound message that resolved to an address for this phone".
create index if not exists idx_text_jake_conv_msgs_phone_created
    on text_jake_conversation_messages (phone, created_at desc, id desc);
