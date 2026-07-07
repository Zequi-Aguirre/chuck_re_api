-- JAK-report-default-50 — Correct the new-customer REPORT default grant to 50.
--
-- The JAK-161 split-buckets migration seeded the admin-editable new-customer
-- default grant `default_report_credits` = 100. That 100 was a voice-to-text
-- slip: the intended report default is 50 (skip-trace and comps stay at 10).
--
-- `default_report_credits` lives in `app_settings` (the admin-editable KV store),
-- and `CreditSettingsService.defaultGrant` reads that stored value in preference
-- to the code default — so fixing only the code constant would NOT change any DB
-- that already ran JAK-161. This migration flips the stored value to 50.
--
-- We can't just edit the JAK-161 migration: postgrator validates md5 checksums of
-- applied migrations and only runs versions newer than the DB's, so an edit would
-- both break `migrate.sh` on deployed DBs and never re-run there. A forward
-- migration is the correct fix.
--
-- Guarded to `value = '100'` so this only heals the erroneous default and never
-- clobbers a deliberate admin change (any intentional value would not be 100).
-- Idempotent: a re-run finds no '100' row and is a no-op.
update app_settings
   set value = '50'
 where key = 'default_report_credits'
   and value = '100';
