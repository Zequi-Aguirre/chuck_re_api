-- JAK-125 — Superadmin role: restrict admin management to superadmins.
--
-- Adds a `role` to admin_users so we can distinguish a plain operator (`admin`,
-- full sub-account management) from a `superadmin` (may additionally add, manage,
-- deactivate and reset the password of OTHER admins). Existing rows default to
-- the least-privileged 'admin'; the seeded bootstrap account is promoted to
-- 'superadmin' at boot (see AdminAuthService.seedFirstAdmin) — no manual DB
-- surgery, no credential in SQL.
--
-- A CHECK constraint pins the allowed values so a bad role can never be written.
-- Follows the existing snake_case / column-with-default convention.

alter table admin_users
    add column if not exists role text not null default 'admin';

-- Postgres has no "add constraint if not exists", so guard it for a re-run.
do $$
begin
    if not exists (
        select 1 from pg_constraint where conname = 'admin_users_role_check'
    ) then
        alter table admin_users
            add constraint admin_users_role_check
            check (role in ('admin', 'superadmin'));
    end if;
end $$;
