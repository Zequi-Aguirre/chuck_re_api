/**
 * Auto-enrichment field catalog (JAK-185, epic JAK-180).
 *
 * The ONE source of truth mapping each {@link AutoEnrichmentFields} logical key
 * (JAK-184 formatter output) to the GHL custom-field DISPLAY NAME we discover it
 * by. Zequi confirmed Eric's GHL account creates these fields via Eric's prompt,
 * so we NEVER hand-enter field ids — the write-back resolves ids by matching
 * these names against the location's custom-field catalog (JAK-185 resolver).
 *
 * Order is the display order; it also fixes a stable iteration order for the
 * write payload. A drift-guard test asserts every value key in
 * {@link AutoEnrichmentFields} has exactly one catalog entry, so the formatter and
 * the write-back can never silently disagree on the field set.
 */
import { AutoEnrichmentFields } from "./AutoEnrichmentTypes";

/** The logical value keys of a formatter result (everything except… nothing —
 * all of them are written, including the always-present `mlsStatus`). */
export type AutoEnrichmentFieldKey = keyof AutoEnrichmentFields;

/** One catalog entry: a formatter key and the GHL display name it maps to. */
export interface AutoEnrichmentFieldDef {
  /** Key on the JAK-184 formatter output. */
  key: AutoEnrichmentFieldKey;
  /** Exact GHL custom-field display name Eric's prompt creates. */
  name: string;
}

/**
 * The canonical catalog. Names are the GHL display names to match by; keys are the
 * JAK-184 output keys, reused verbatim (never re-invented). 18 fields.
 */
export const AUTO_ENRICHMENT_FIELDS: readonly AutoEnrichmentFieldDef[] = [
  { key: "dealSignals", name: "Jake Deal Signals" },
  { key: "mlsStatus", name: "MLS Status" },
  { key: "propertyType", name: "Property Type" },
  { key: "estimatedEquity", name: "Estimated Equity" },
  { key: "equityPercent", name: "Equity %" },
  { key: "estimatedValue", name: "Estimated Value" },
  { key: "mortgageBalance", name: "Mortgage Balance" },
  { key: "monthlyMortgage", name: "Monthly Mortgage" },
  { key: "ownerOfRecord", name: "Owner of Record" },
  { key: "yearsOwned", name: "Years Owned" },
  { key: "beds", name: "Beds" },
  { key: "baths", name: "Baths" },
  { key: "sqFt", name: "Sq Ft" },
  { key: "lotSize", name: "Lot Size" },
  { key: "yearBuilt", name: "Year Built" },
  { key: "lastSaleDate", name: "Last Sale Date" },
  { key: "lastSalePrice", name: "Last Sale Price" },
  { key: "propertyAddress", name: "Property Address" },
] as const;

/**
 * Normalize a GHL field display name for matching: trim, lowercase, and collapse
 * internal whitespace. Both our catalog names and the location's fetched field
 * names run through this, so cosmetic casing/spacing differences in how Eric's
 * prompt names a field don't break the name→id match. The `%` in "Equity %" is
 * preserved (only whitespace/case is normalized).
 */
export const normalizeFieldName = (name: string): string =>
  name.trim().toLowerCase().replace(/\s+/g, " ");
