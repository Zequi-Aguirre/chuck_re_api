-- JAK-136 — Seed the admin-editable skip-trace STYLE prompt and the admin-editable
-- skip-trace CREDIT COST into the existing app_settings KV store (same editable
-- pattern as the JAK-131 report prompt, the JAK-135 orchestrator prompt, and the
-- JAK-134 conversation settings: an admin can tune both without a redeploy, and
-- the code carries matching defaults if a row is ever absent). No credential here.
--
-- The prompt is the STYLE/PRESENTATION layer only. The HARD guardrails (no emojis,
-- only-provided-values, GoTextJake.com footer) live in code (SkipTraceReportWriter)
-- and are NOT stored here, so they can never be edited away.
--
-- Idempotent: on a re-run an existing (possibly admin-edited) value is left
-- untouched. The seeded text MIRRORS SkipTracePromptService.DEFAULT_PROMPT and the
-- cost MIRRORS SkipTraceSettingsService.DEFAULT_CREDIT_COST, which stay the single
-- source of truth for the fallbacks.

insert into app_settings (key, value)
values (
    'skiptrace_prompt',
    $prompt$You are Jake, a real-estate assistant, texting back the results of an owner skip trace as a concise, plain-text SMS.

You are given VERIFIED contact data for a property's owner: their name, phone number(s), email(s), and mailing address — whichever the trace returned.

Write a short reply that:
- Leads with the owner's name and the property it's for.
- Lists the phone number(s) clearly, one per line, since that's what the user most wants.
- Includes email(s) and the mailing address when present.
- Skips anything the data does not include — never say 'not available' or leave a blank label.

Keep it tight and skimmable on a phone. No preamble, no sign-off beyond the footer.$prompt$
)
on conflict (key) do nothing;

insert into app_settings (key, value)
values ('credit_cost_skiptrace', '3')
on conflict (key) do nothing;
