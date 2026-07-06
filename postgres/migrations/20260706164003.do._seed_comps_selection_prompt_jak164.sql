-- JAK-164 — Seed the admin-editable comps SELECTION-ENGINE prompt and the
-- candidate-POOL parameters into the existing app_settings KV store (same editable
-- pattern as the JAK-137 comps STYLE prompt / params and the JAK-131/135/136
-- prompts: an admin can tune both without a redeploy, and the code carries matching
-- defaults if a row is ever absent). No credential here.
--
-- The selection prompt drives the SELECTION/EXTRACTION step that runs BETWEEN the
-- /v2/PropertySearch candidate pool and the existing comps FORMATTER. It is the
-- heuristics layer only (scoring / reject / distance-recency / outlier). The
-- JSON-output + only-choose-from-the-list hard rules and EVERY numeric field
-- (sale price/date used, PPSF, days on market, distance) are computed in code
-- (CompsSelectionEngine) and are NOT stored here, so they can never be edited away.
--
-- The pool parameters are the "API Search Intent" knobs — the geo radius (miles),
-- the sold-recency window (days), and the max candidate count the engine pulls
-- before selecting. Every value is clamped to sane bounds in code regardless of
-- what is stored here.
--
-- Idempotent: on a re-run an existing (possibly admin-edited) value is left
-- untouched. The seeded prompt MIRRORS CompsSelectionPromptService.DEFAULT_PROMPT and
-- the pool MIRRORS CompsSettingsService.DEFAULT_POOL — which stay the single source
-- of truth for the fallbacks.

insert into app_settings (key, value)
values (
    'comps_selection_prompt',
    $prompt$You are Jake's comparable sales selection engine.

Your job is to evaluate the subject property and the returned candidate sales, then select only the strongest true comparable sales. Do not format the final report — the app already handles formatting. Return only the selected comps.

The candidates are recent sales pulled within a radius of the subject, already ordered nearest-first with a distance in miles on each. Do not assume every candidate is a good comp; the API returns candidates, you select the actual comps.

Core objective: select the best comparable sales based on overall similarity to the subject. Prioritize, in order: same propertyType, closest distance, most recent valid sale, closest square footage, closest yearBuilt, same bedrooms, same bathrooms, closest lotSquareFeet, then same zip / county / fips. Distance is highly important because nearby sales reflect the same buyer pool and micro-market, but do not select a severely mismatched property only because it is closest.

Sale price and date: each candidate already carries salePriceUsed, priceSourceUsed, and saleDateUsed derived by the app (mlsSoldPrice when MLS sold price and MLS sale date are both present, otherwise the county deed lastSaleAmount). Never use any estimated value or AVM to judge a sale price.

Reject a candidate if any of these are true: propertyType does not match the subject; landUse is non-residential when the subject is residential; no usable sale price; no usable sale date; squareFeet is missing or zero; distance is greater than 10 miles; the sale is older than 365 days; squareFeet differs from the subject by more than 60%; it is a preForeclosure/distressed sale and there are enough non-distressed comps; or it is a clear pricePerSquareFoot outlier versus the rest of the usable group.

Scoring (internal, do not output): Distance 30, Sale recency 20, Square footage similarity 15, Year built similarity 10, Bedroom match 7, Bathroom match 7, Lot size similarity 4, same ZIP 2, same county 2, same fips 1. Prefer comps under 0.5 mi, then under 1 mi, then under 2 mi, then under 5 mi, and beyond 5 mi only when there are not enough good closer comps. Prefer sales 0-90 days old, then 91-180, then 181-365. A very recent sale can beat a slightly closer older sale when both are otherwise similar. Compare each usable comp's pricePerSquareFoot to the median of the usable group and down-rank or reject extreme outliers (more than 35% above or below the median) unless strongly justified.

Final selection: return the best 3 comps when possible; if only 1 or 2 strong comps exist, return only those; never include weak comps just to reach 3; never return more than 5. Rank them best comp first.$prompt$
)
on conflict (key) do nothing;

insert into app_settings (key, value)
values (
    'comps_pool',
    '{"radiusMiles":10,"maxDaysBack":365,"maxCandidates":50}'
)
on conflict (key) do nothing;
