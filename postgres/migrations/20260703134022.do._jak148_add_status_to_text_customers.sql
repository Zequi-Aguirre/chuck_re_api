-- JAK-148: two-level hold for text customers. Add a per-customer `status` with
-- three states so an admin can pause or fully switch off a texter WITHOUT ever
-- touching their credit balance:
--   active       — normal: GHL forwards their texts, Jake processes + charges.
--   on_hold      — SOFT hold: GHL still forwards (the "text Jake" field stays
--                  approved), but Jake intercepts inbound server-side, replies a
--                  friendly hold notice, and does NOT process or charge.
--   deactivated  — HARD off: the "text Jake" field is flipped to unapproved via
--                  the JAK-147 sync so GHL stops forwarding entirely; a backstop
--                  in the inbound handler still refuses to process/charge if one
--                  slips through.
-- Default 'active' so every existing customer keeps working unchanged. A CHECK
-- keeps the column to the three known states. Credits live in the JAK-109 ledger
-- and are untouched by any status change.
alter table text_jake_customers
    add column if not exists status text not null default 'active';

alter table text_jake_customers
    drop constraint if exists text_jake_customers_status_check;

alter table text_jake_customers
    add constraint text_jake_customers_status_check
    check (status in ('active', 'on_hold', 'deactivated'));
