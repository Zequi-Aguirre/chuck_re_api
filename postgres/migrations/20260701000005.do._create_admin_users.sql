-- JAK-113 — Admin dashboard auth: the internal operators who onboard beta
-- sub-accounts.
--
-- One row per admin user (for beta, that's just Zequi). The password is stored
-- ONLY as a bcrypt hash (`password_hash`) — never plaintext, never reversible,
-- per the secret-storage rule. There is no seeded credential in this migration:
-- the first admin is created at boot from ADMIN_SEED_EMAIL / ADMIN_SEED_PASSWORD
-- (Doppler), so no password ever lives in the repo or in SQL.
--
-- Column + timestamp naming follows the existing snake_case / timestamptz
-- convention (created_at / updated_at). Email is stored lowercased + unique so a
-- login lookup is a single indexed hit and a user can't be duplicated by case.

create table if not exists admin_users (
    id             uuid          primary key default gen_random_uuid(),
    -- Login identity. Stored lowercased; unique so one email = one admin.
    email          text          not null unique,
    -- bcrypt hash of the password. NEVER plaintext, NEVER reversible.
    password_hash  text          not null,
    created_at     timestamptz   not null default now(),
    updated_at     timestamptz   not null default now()
);
