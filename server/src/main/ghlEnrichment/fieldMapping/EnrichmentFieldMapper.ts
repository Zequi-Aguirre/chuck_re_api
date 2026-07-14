/**
 * Enrichment → GHL custom-field mapping (JAK-108).
 *
 * The pure, side-effect-free layer between Jake's enrichment engine output
 * ({@link EnrichmentResult}) and the GHL custom fields JAK-105 auto-provisions
 * per location. Given an enrichment result and the location's field-id map
 * (Jake field key → GHL-assigned field id), it returns the exact
 * {@link GhlCustomFieldValue}[] payload that
 * {@link import("../api/GhlApiClient").GhlApiClient.updateContactCustomFields}
 * expects.
 *
 * It does NOT call the API, the store, or the network — the caller (JAK-107)
 * loads the field-id map and dispatches the write. Keeping this a pure function
 * makes the value-shaping rules exhaustively unit-testable.
 *
 * Field KEYS come from the one canonical catalog ({@link JAKE_CUSTOM_FIELDS});
 * this module only owns turning an {@link EnrichmentResult} into per-field
 * VALUES. A `FieldValueExtractors` entry is keyed by that same catalog key, and
 * a unit test asserts the two sets match exactly, so a catalog change can never
 * silently drift from the mapping.
 */
import { GhlCustomFieldValue } from "../api/GhlApiTypes";
import { JAKE_CUSTOM_FIELDS } from "../lifecycle/JakeCustomFields";
import { EnrichmentResult } from "../../types/LeadEnrichment";

/**
 * Per-location lookup from a stable Jake field key (e.g. `jake_owner_name`) to
 * the GHL-assigned custom field id for that location. Built from the rows
 * JAK-105 persists in `ghl_custom_fields`.
 */
export type LocationFieldIdMap = ReadonlyMap<string, string>;

/** Minimal row shape needed to build a {@link LocationFieldIdMap}. */
interface FieldIdSource {
  jake_field_key: string;
  ghl_field_id: string;
}

/**
 * Build the per-location field-id map from provisioned-field rows (the output of
 * `GhlCustomFieldStore.listByLocation`). Later rows win on a duplicate key.
 */
export const buildLocationFieldIdMap = (
  rows: readonly FieldIdSource[]
): LocationFieldIdMap => {
  const map = new Map<string, string>();
  for (const row of rows) {
    if (row.jake_field_key && row.ghl_field_id) {
      map.set(row.jake_field_key, row.ghl_field_id);
    }
  }
  return map;
};

/**
 * Extracts one field's write value from an enrichment result. Returning
 * `undefined` means "no value for this field" — the mapper then skips it so we
 * never write an empty/null over a field a user or another integration set.
 */
type FieldValueExtractor = (result: EnrichmentResult) => unknown | undefined;

/** A trimmed, non-empty string, or `undefined` to skip. */
const nonEmptyString = (value: string | null | undefined): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

/** A finite number (including 0), or `undefined` to skip null/NaN/Infinity. */
const finiteNumber = (value: number | null | undefined): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/**
 * One extractor per canonical field key. Booleans are always written (both
 * `true` and `false` are meaningful for a CHECKBOX); nullable text/number/date
 * fields are skipped when absent; the reasons list is joined and skipped when
 * empty.
 */
const FIELD_VALUE_EXTRACTORS: Readonly<Record<string, FieldValueExtractor>> = {
  jake_owner_name: (r) => nonEmptyString(r.ownerName),
  jake_actively_listed: (r) => r.isActiveListed,
  jake_last_sale_price: (r) => finiteNumber(r.lastSalePrice),
  jake_last_sold_date: (r) => nonEmptyString(r.lastSoldDate),
  jake_mortgage_amount: (r) => finiteNumber(r.mortgageAmount),
  jake_foreclosure_active: (r) => r.foreclosureActive,
  jake_disqualified: (r) => r.disqualify,
  jake_disqualify_reasons: (r) =>
    nonEmptyString(r.disqualifyReasons.map((s) => s.trim()).filter(Boolean).join("; ")),
};

/** Exported for the drift-guard test — not part of the runtime contract. */
export const FIELD_VALUE_EXTRACTOR_KEYS = Object.keys(FIELD_VALUE_EXTRACTORS);

/**
 * Map an enrichment result to the custom-field write payload for one location.
 *
 * Walks the canonical catalog in display order and, for each field, emits a
 * `{ id, value }` entry only when BOTH hold:
 *   - the enrichment result has a real value for it (missing/null → skipped), and
 *   - the location has that field provisioned (its id is in `fieldIds`).
 *
 * Targets fields by GHL id (unambiguous per location) rather than key. Pure:
 * same inputs always yield the same array; no I/O.
 */
export const mapEnrichmentToCustomFields = (
  result: EnrichmentResult,
  fieldIds: LocationFieldIdMap
): GhlCustomFieldValue[] => {
  const values: GhlCustomFieldValue[] = [];
  for (const field of JAKE_CUSTOM_FIELDS) {
    const extract = FIELD_VALUE_EXTRACTORS[field.key];
    if (!extract) continue;
    const value = extract(result);
    if (value === undefined) continue;
    const id = fieldIds.get(field.key);
    if (!id) continue;
    values.push({ id, value });
  }
  return values;
};
