/**
 * The canonical Jake → GHL custom field catalog (JAK-105).
 *
 * ONE place defines the fields Jake provisions into every sub-account on install
 * and later writes enrichment results into. Each entry maps 1:1 to a field on
 * {@link import("../../types/LeadEnrichment").EnrichmentResult}, so the install
 * lifecycle (this ticket) and the enrichment write-back (JAK-107/JAK-108) agree
 * on names, keys, and types without a second source of truth.
 *
 * `key` is the STABLE identifier: it's what we store as `jake_field_key`, what we
 * request as the GHL `fieldKey`, and what a re-install matches on to stay
 * idempotent. It never changes once shipped — GHL field ids differ per location,
 * but this key is constant everywhere.
 *
 * JAK-108 (field mapping) owns turning an EnrichmentResult into per-field VALUES;
 * this module owns only the field DEFINITIONS.
 */

/** GHL custom field data types we provision. Mirrors GHL API v2 `dataType`. */
export type JakeFieldDataType =
  | "TEXT"
  | "LARGE_TEXT"
  | "NUMERICAL"
  | "MONETORY"
  | "DATE"
  | "CHECKBOX";

/** A single canonical field definition. */
export interface JakeCustomFieldDef {
  /** Stable Jake field key — persisted, requested as GHL fieldKey, idempotency key. */
  key: string;
  /** Human-readable name shown in the GHL UI. */
  name: string;
  /** GHL data type to provision the field as. */
  dataType: JakeFieldDataType;
}

/**
 * The canonical set. Order is the display order in GHL. Grounded in
 * {@link import("../../types/LeadEnrichment").EnrichmentResult} — one field per
 * enrichment output the worker writes back.
 */
export const JAKE_CUSTOM_FIELDS: readonly JakeCustomFieldDef[] = [
  { key: "jake_owner_name", name: "Jake Owner Name", dataType: "TEXT" },
  { key: "jake_actively_listed", name: "Jake Actively Listed", dataType: "CHECKBOX" },
  { key: "jake_last_sale_price", name: "Jake Last Sale Price", dataType: "MONETORY" },
  { key: "jake_last_sold_date", name: "Jake Last Sold Date", dataType: "DATE" },
  { key: "jake_mortgage_amount", name: "Jake Mortgage Amount", dataType: "MONETORY" },
  { key: "jake_foreclosure_active", name: "Jake Foreclosure Active", dataType: "CHECKBOX" },
  { key: "jake_disqualified", name: "Jake Disqualified", dataType: "CHECKBOX" },
  { key: "jake_disqualify_reasons", name: "Jake Disqualify Reasons", dataType: "LARGE_TEXT" },
] as const;

/**
 * Normalize a GHL `fieldKey` to a canonical `key` for matching. GHL prefixes a
 * requested fieldKey with its model, e.g. we send `jake_owner_name` and GHL
 * returns `contact.jake_owner_name`; this strips that prefix so a re-install can
 * recognize a field it (or an operator) already created.
 */
export const normalizeFieldKey = (fieldKey: string): string =>
  fieldKey.includes(".") ? fieldKey.slice(fieldKey.indexOf(".") + 1) : fieldKey;
