-- JAK-132 — Refresh the seeded property-report STYLE prompt so the LLM report
-- surfaces the money + distress signals now fed to it (mortgage balance/payment,
-- estimated equity, foreclosure/pre-foreclosure/REO/auction, tax lien, judgment).
--
-- The full /v2/PropertySearch record is now handed to the writer, so the prompt
-- gains a Financials section and a Distress / Liens section, plus explicit rules
-- that liens are Yes/No FLAGS (never a dollar amount) and that false/absent
-- distress flags must be omitted or shown as one reassuring line — never printed
-- as "false"/raw field names.
--
-- This MIRRORS PropertyReportPromptService.DEFAULT_STYLE_PROMPT (the code default,
-- still the single source of truth). We update ONLY the untouched seed
-- (updated_by IS NULL) so an admin's customized prompt is never clobbered. No
-- credential lives in this migration.

update app_settings
set value = $prompt$Write a "Jake Property Report" as a clean, scannable plain-text SMS.

You receive the full verified property record plus a block of derived highlights. Use whichever fields are useful; you do not have to include every field.

Lay it out as grouped sections separated by a single blank line. Include a section ONLY when the data has at least one relevant field; silently drop any section or field that has no data.

1. A headline line: Jake Property Report
2. The property address (street on its own line; the city, state and ZIP on the next line when provided).
3. Property - property type, beds and baths (for example "4 Beds | 2 Baths"), square footage, lot size, year built.
4. Estimated Market Value - the estimated market value.
5. Ownership - owner name(s), equity (percent and whether it is free and clear), equity level, occupancy, absentee status, years owned.
6. Financials - estimated mortgage balance (openMortgageBalance), estimated mortgage payment (estimatedMortgagePayment), and estimated equity in dollars (estimatedEquity). Include only the ones present.
7. Distress / Liens - foreclosure, pre-foreclosure, bank-owned/REO, auction (with its date if given), tax lien, and judgment.
8. History - last sold date and sale price.
9. Additional Information - FEMA flood zone, MLS listing status, and any other useful provided facts.

Distress and lien rules (read carefully):
- foreclosure, preForeclosure, reo, auction, taxLien and judgment are Yes/No FLAGS, not amounts. There is NO dollar figure for liens - never invent or imply one.
- List a distress or lien item ONLY when its flag is true (for example, print "Tax Lien" only when taxLien is true).
- A flag that is false or absent means it is NOT on record. Do NOT print it, and never write the words "false", "true", "null", or the raw field name.
- If every distress and lien flag is false or absent, either omit the Distress / Liens section entirely or show a single reassuring line: "No liens or foreclosure on record".

Formatting:
- Put each section's label on its own line, then list that section's facts as "- " bullets on the lines below it.
- Leave exactly one blank line between sections.
- Format numbers with thousands separators and prices with a leading $.
- Keep the tone warm but concise - this is a text message, not a brochure.$prompt$
where key = 'property_report_prompt'
  and updated_by is null;
