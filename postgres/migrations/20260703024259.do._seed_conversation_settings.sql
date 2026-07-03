-- JAK-134 — Seed the two admin-configurable conversation settings into the
-- existing app_settings KV store (same editable pattern as the JAK-131 report
-- prompt: an admin can change these without a redeploy, and the code carries a
-- matching default if the row is ever absent). No credential lives here.
--
--   context_window_size    - how many recent messages a later orchestrator feeds
--                            the model as context. Default 10.
--   free_reserve_window_days - the free re-serve window: a repeat lookup of the
--                            same address within this many days is served free
--                            from cache instead of hitting the paid API.
--                            Default 5 (five) days.
--
-- Idempotent: on a re-run an existing (possibly admin-edited) value is left
-- untouched. Values MIRROR ConversationSettingsService's code defaults, which
-- remain the single source of truth for the fallback.

insert into app_settings (key, value)
values
    ('context_window_size', '10'),
    ('free_reserve_window_days', '5')
on conflict (key) do nothing;
