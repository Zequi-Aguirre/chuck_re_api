-- JAK-first-text-welcome — first-text welcome + delayed onboarding email ask.
--
-- Two pieces of per-customer state and one admin-editable prompt:
--
-- 1) report_count — how many property reports Jake has delivered to this
--    customer. The onboarding email ask fires ONCE, right after the 3rd report
--    completes, so we need a durable counter. Defaults to 0 for every existing
--    customer, so the ask fires after their next three reports (never retroactively
--    on old activity we didn't count).
--
-- 2) onboarding_asked_at — when the after-3rd-report email ask was sent, or NULL
--    if it hasn't been. Doubles as the once-only guard (the ask is marked with a
--    conditional `... WHERE onboarding_asked_at IS NULL` update) and the flag that
--    turns on follow-up profile capture (name/email) for this customer.
--
-- 3) app_settings seed — the admin-editable wording of that email ask
--    (`onboarding_email_ask_prompt`). Same KV pattern as the other editable
--    prompts + out-of-credits messages; the code default in OnboardingPromptService
--    MIRRORS the seed below, and the GoTextJake.com footer is appended by the
--    sender (never stored here, so it can't be edited away).
alter table text_jake_customers
    add column if not exists report_count       integer     not null default 0,
    add column if not exists onboarding_asked_at timestamptz;

insert into app_settings (key, value)
values (
    'onboarding_email_ask_prompt',
    $prompt$Hey, we're getting to know each other. If you'd like the full report emailed to you, send me your name and email.$prompt$
)
on conflict (key) do nothing;
