-- JAK-115 — Text-Jake customers: the tier-1 billing identity, keyed by phone.
--
-- Text-Jake resolves the texting customer by their SENDER phone number (both
-- text modes — gateway and own_number). This table is that identity + its credit
-- account: one row per distinct sender phone (E.164). The row id doubles as the
-- customer's credit-account key against the JAK-109 credit_ledger — so a texter
-- always maps to the same customer and the same credit balance.
--
-- This is DISTINCT from ghl_connections (JAK-102): a connection is a customer's
-- own GHL sub-account + per-tenant key (used for enrichment write-back and, when
-- text_mode='own_number', for their text-Jake). A text_jake_customer is the
-- individual who texted in and whose prepaid credits are drawn down.
--
-- No FK to anything: billing identity must outlive any connection change, so
-- location links are plain nullable columns. Column/timestamp naming follows the
-- existing snake_case / timestamptz convention (created/modified/deleted).

create table if not exists text_jake_customers (
    id               uuid          primary key default gen_random_uuid(),
    -- Sender phone number, E.164. One customer per number.
    phone            text          not null unique,
    -- The customer's contact id in the GHL sub-account that handles their texts
    -- (the shared gateway sub-account for gateway mode, or their own sub-account
    -- for own_number). Nullable until first seen. Status notes target it.
    ghl_contact_id   text,
    created_at       timestamptz   not null default now(),
    modified_at      timestamptz   not null default now(),
    deleted_at       timestamptz
);
