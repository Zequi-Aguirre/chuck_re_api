-- JAK-124 — Admin management: a logged-in admin can create and enable/disable
-- other admins from the dashboard.
--
-- Adds an `is_active` flag so an admin can be disabled without deleting the row
-- (audit trail preserved). Existing admins default to active. The password is
-- still stored ONLY as a bcrypt hash (see JAK-113's create_admin_users) — this
-- migration touches no credential.
--
-- Follows the existing snake_case / boolean-with-default convention.

alter table admin_users
    add column if not exists is_active boolean not null default true;
