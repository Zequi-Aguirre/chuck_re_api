-- JAK-115 — Per-customer text mode on the connection record.
--
-- Text-Jake runs in one of two modes, selected per customer:
--
--   'gateway'    — DEFAULT. Texts flow through Zequi's ONE shared Jake sub-account
--                  using the app-level MASTER GATEWAY KEY (Doppler:
--                  JAKE_GATEWAY_GHL_API_KEY / _LOCATION_ID / _BASE_URL — never in
--                  this DB). Zequi's number, Zequi pays SMS. Tier-1 / trial.
--
--   'own_number' — OPT-IN at tier-2 enrichment signup. Text-Jake runs INSIDE the
--                  customer's OWN sub-account using this row's encrypted
--                  per-tenant key + a number they assign (phone_numbers). Cost
--                  shifts to the customer. This is the JAK-114 per-tenant text
--                  routing, preserved.
--
-- Default 'gateway' so every existing connection (and any tier-1 customer without
-- a connection at all) uses the shared gateway until explicitly opted in.

alter table ghl_connections
    add column if not exists text_mode text not null default 'gateway';
