-- JAK-138 — Pending DISAMBIGUATION state: the ONE outstanding "which address did
-- you mean?" question per phone.
--
-- When a texter asks for an address-based action (property report, skip-trace,
-- comps) but the reference is ambiguous (multiple addresses on file, no clear
-- pick) or out of range, Jake replies with a NUMBERED list of the addresses and
-- asks which one — instead of guessing or silently failing (the JAK-138
-- disambiguation polish). This row remembers WHICH intent was pending so a
-- following bare number/ordinal ("2", "the last one") can select the address and
-- run that intent, tying back into JAK-135 reference resolution. The address
-- itself is NOT stored: it is re-derived from the stable, ordered per-phone
-- resolved-address list at selection time, so the ordinal always maps to the same
-- address it did when the list was shown.
--
-- One row per phone (phone is the PK), upserted, so a new question always
-- replaces any prior one. `comp_params` carries the texter's comp parameter
-- overrides through for a pending comps question (null for report/skip-trace).
-- The freshness TTL lives in the service (a stale question can never fire later).
-- No credential lives here.
create table if not exists text_jake_pending_disambiguation (
    phone         text          primary key,
    customer_id   uuid          not null references text_jake_customers (id) on delete cascade,
    intent        text          not null,
    comp_params   jsonb,
    created_at    timestamptz   not null default now()
);
