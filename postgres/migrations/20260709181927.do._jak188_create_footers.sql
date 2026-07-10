-- JAK-188 — Admin-managed pool of rotating reply footers.
--
-- Replaces the single hardcoded reply footer (JAK-157/158) with a GLOBAL pool of
-- admin-managed footers that rotate randomly per outbound message. One row per
-- footer; multi-line text supported. `active` gates whether a footer is in the
-- rotation (default true). Scope is GLOBAL (not per sub-account).
--
-- Add-only + idempotent (create table IF NOT EXISTS).

create table if not exists footers (
    id          uuid         primary key default gen_random_uuid(),
    -- The footer text, exactly as sent. Multi-line supported (stored verbatim).
    text        text         not null,
    -- In the random rotation when true; parked (never chosen) when false.
    active      boolean      not null default true,
    created_at  timestamptz  not null default now(),
    updated_at  timestamptz  not null default now()
);

-- VALUE-GUARDED SEED: insert the CURRENT default footer (the exact existing
-- two-line JAK-157/158 string) as the first ACTIVE footer, so day-1 behavior is
-- unchanged — with only this seed active, the random pick is always the default.
-- Guarded on the exact text so a re-run never inserts a duplicate (idempotent).
-- The code default (PropertyReportWriter.FOOTER) MIRRORS this seed verbatim.
insert into footers (text, active)
select $footer$Every Lead Deserves Jake.
GoTextJake.com/CRM$footer$, true
where not exists (
    select 1 from footers
    where text = $footer$Every Lead Deserves Jake.
GoTextJake.com/CRM$footer$
);
