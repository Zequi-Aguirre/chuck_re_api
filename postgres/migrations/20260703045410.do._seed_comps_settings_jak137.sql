-- JAK-137 — Seed the admin-editable comps STYLE prompt, the admin-editable comps
-- CREDIT COST, and the admin-editable DEFAULT comp PARAMETERS into the existing
-- app_settings KV store (same editable pattern as the JAK-131 report prompt, the
-- JAK-135 orchestrator prompt, the JAK-136 skip-trace settings, and the JAK-134
-- conversation settings: an admin can tune all three without a redeploy, and the
-- code carries matching defaults if a row is ever absent). No credential here.
--
-- The prompt is the STYLE/PRESENTATION layer only. The HARD guardrails (no emojis,
-- only-provided-values, GoTextJake.com footer) live in code (CompsReportWriter)
-- and are NOT stored here, so they can never be edited away.
--
-- The default comp parameters are the fallback the specialist uses when the texter
-- doesn't specify their own (radius, number of comps, timeframe, bed/bath/sqft
-- tolerance). A texter's in-message overrides still win, and every value is clamped
-- to sane bounds in code regardless of what is stored here.
--
-- Idempotent: on a re-run an existing (possibly admin-edited) value is left
-- untouched. The seeded text MIRRORS CompsPromptService.DEFAULT_PROMPT, the cost
-- MIRRORS CompsSettingsService.DEFAULT_CREDIT_COST, and the params MIRROR
-- CompsSettingsService.DEFAULT_PARAMS — which stay the single source of truth for
-- the fallbacks.

insert into app_settings (key, value)
values (
    'comps_prompt',
    $prompt$You are Jake, a real-estate assistant, texting back a comparable-sales (comps) summary as a concise, plain-text SMS.

You are given VERIFIED comparable sales for a subject property: for each comp its address, sale price, beds/baths/square feet, distance from the subject, and sale date — whichever the data returned. You may also be given an estimated value range for the subject.

Write a short reply that:
- Opens with the subject address and the parameters used (search radius, number of comps, timeframe, and bed/bath/sqft tolerance).
- Lists each comparable on its own compact block: address, sale price, then beds/baths/sqft and distance/date when present.
- Ends with a one-line summary — an average or estimated range — ONLY if the data supports it.
- Skips anything the data does not include — never say 'not available' or leave a blank label, and never invent a comp or a price.

Keep it tight and skimmable on a phone. No preamble, no sign-off beyond the footer.$prompt$
)
on conflict (key) do nothing;

insert into app_settings (key, value)
values ('credit_cost_comps', '3')
on conflict (key) do nothing;

insert into app_settings (key, value)
values (
    'comps_params',
    '{"radiusMiles":1,"count":5,"monthsBack":12,"bedsTolerance":1,"bathsTolerance":1,"sqftTolerancePct":25}'
)
on conflict (key) do nothing;
