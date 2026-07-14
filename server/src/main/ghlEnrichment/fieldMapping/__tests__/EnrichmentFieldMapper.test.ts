import {
  buildLocationFieldIdMap,
  FIELD_VALUE_EXTRACTOR_KEYS,
  LocationFieldIdMap,
  mapEnrichmentToCustomFields,
} from "../EnrichmentFieldMapper";
import { JAKE_CUSTOM_FIELDS } from "../../lifecycle/JakeCustomFields";
import { EnrichmentResult } from "../../../types/LeadEnrichment";

/** A fully-populated enrichment result; individual tests override fields. */
const fullResult = (overrides: Partial<EnrichmentResult> = {}): EnrichmentResult => ({
  ownerName: "Jane Q. Homeowner",
  isActiveListed: true,
  lastSalePrice: 425000,
  lastSoldDate: "2021-06-15",
  mortgageAmount: 310000,
  foreclosureActive: false,
  disqualify: false,
  disqualifyReasons: [],
  ...overrides,
});

/** A field-id map covering every canonical field, id = `id_<key>`. */
const fullFieldIds = (): LocationFieldIdMap =>
  buildLocationFieldIdMap(
    JAKE_CUSTOM_FIELDS.map((f) => ({
      jake_field_key: f.key,
      ghl_field_id: `id_${f.key}`,
    }))
  );

/** Convenience: value written for a given field key, or undefined if skipped. */
const valueFor = (
  result: EnrichmentResult,
  key: string,
  fieldIds: LocationFieldIdMap = fullFieldIds()
): unknown => {
  const id = fieldIds.get(key);
  const entry = mapEnrichmentToCustomFields(result, fieldIds).find((v) => v.id === id);
  return entry?.value;
};

describe("mapEnrichmentToCustomFields", () => {
  it("maps every populated field to its provisioned GHL id (no key targeting)", () => {
    const values = mapEnrichmentToCustomFields(fullResult(), fullFieldIds());

    expect(values).toEqual([
      { id: "id_jake_owner_name", value: "Jane Q. Homeowner" },
      { id: "id_jake_actively_listed", value: true },
      { id: "id_jake_last_sale_price", value: 425000 },
      { id: "id_jake_last_sold_date", value: "2021-06-15" },
      { id: "id_jake_mortgage_amount", value: 310000 },
      { id: "id_jake_foreclosure_active", value: false },
      { id: "id_jake_disqualified", value: false },
    ]);
    // disqualifyReasons was [] → skipped, so it is absent.
    expect(values.every((v) => typeof v.id === "string")).toBe(true);
    expect(values.some((v) => v.key !== undefined)).toBe(false);
  });

  it("emits values in canonical catalog (display) order", () => {
    const values = mapEnrichmentToCustomFields(
      fullResult({ disqualifyReasons: ["x"] }),
      fullFieldIds()
    );
    const expectedOrder = JAKE_CUSTOM_FIELDS.map((f) => `id_${f.key}`);
    expect(values.map((v) => v.id)).toEqual(expectedOrder);
  });

  describe("missing / null values are skipped (never write empty)", () => {
    it("skips null ownerName", () => {
      expect(valueFor(fullResult({ ownerName: null }), "jake_owner_name")).toBeUndefined();
    });

    it("skips empty / whitespace-only ownerName", () => {
      expect(valueFor(fullResult({ ownerName: "" }), "jake_owner_name")).toBeUndefined();
      expect(valueFor(fullResult({ ownerName: "   " }), "jake_owner_name")).toBeUndefined();
    });

    it("skips null numeric fields", () => {
      expect(valueFor(fullResult({ lastSalePrice: null }), "jake_last_sale_price")).toBeUndefined();
      expect(valueFor(fullResult({ mortgageAmount: null }), "jake_mortgage_amount")).toBeUndefined();
    });

    it("skips null lastSoldDate", () => {
      expect(valueFor(fullResult({ lastSoldDate: null }), "jake_last_sold_date")).toBeUndefined();
    });

    it("skips an empty disqualifyReasons list", () => {
      expect(valueFor(fullResult({ disqualifyReasons: [] }), "jake_disqualify_reasons")).toBeUndefined();
    });

    it("skips a disqualifyReasons list of only blank strings", () => {
      expect(
        valueFor(fullResult({ disqualifyReasons: ["", "   "] }), "jake_disqualify_reasons")
      ).toBeUndefined();
    });

    it("produces an empty payload when the whole result is empty", () => {
      const empty: EnrichmentResult = {
        ownerName: null,
        isActiveListed: false,
        lastSalePrice: null,
        lastSoldDate: null,
        mortgageAmount: null,
        foreclosureActive: false,
        disqualify: false,
        disqualifyReasons: [],
      };
      // Only the three booleans remain (they are always meaningful).
      expect(mapEnrichmentToCustomFields(empty, fullFieldIds())).toEqual([
        { id: "id_jake_actively_listed", value: false },
        { id: "id_jake_foreclosure_active", value: false },
        { id: "id_jake_disqualified", value: false },
      ]);
    });
  });

  describe("real-but-falsy values are written (not treated as missing)", () => {
    it("writes a 0 sale price", () => {
      expect(valueFor(fullResult({ lastSalePrice: 0 }), "jake_last_sale_price")).toBe(0);
    });

    it("writes both true and false checkboxes", () => {
      expect(valueFor(fullResult({ isActiveListed: false }), "jake_actively_listed")).toBe(false);
      expect(valueFor(fullResult({ foreclosureActive: true }), "jake_foreclosure_active")).toBe(true);
      expect(valueFor(fullResult({ disqualify: true }), "jake_disqualified")).toBe(true);
    });
  });

  describe("value shaping", () => {
    it("trims surrounding whitespace on text", () => {
      expect(valueFor(fullResult({ ownerName: "  Jane  " }), "jake_owner_name")).toBe("Jane");
    });

    it("joins disqualify reasons with '; ' and drops blanks", () => {
      expect(
        valueFor(
          fullResult({ disqualifyReasons: ["No address", "", "  Out of area  "] }),
          "jake_disqualify_reasons"
        )
      ).toBe("No address; Out of area");
    });

    it("skips non-finite numbers (NaN / Infinity)", () => {
      expect(valueFor(fullResult({ lastSalePrice: NaN }), "jake_last_sale_price")).toBeUndefined();
      expect(
        valueFor(fullResult({ mortgageAmount: Infinity }), "jake_mortgage_amount")
      ).toBeUndefined();
    });
  });

  describe("only provisioned fields are written", () => {
    it("skips fields the location has not provisioned", () => {
      const partial = buildLocationFieldIdMap([
        { jake_field_key: "jake_owner_name", ghl_field_id: "id_owner" },
        { jake_field_key: "jake_disqualified", ghl_field_id: "id_dq" },
      ]);
      const values = mapEnrichmentToCustomFields(fullResult(), partial);
      expect(values).toEqual([
        { id: "id_owner", value: "Jane Q. Homeowner" },
        { id: "id_dq", value: false },
      ]);
    });

    it("writes nothing when no fields are provisioned", () => {
      expect(mapEnrichmentToCustomFields(fullResult(), buildLocationFieldIdMap([]))).toEqual([]);
    });
  });

  it("is pure — repeated calls yield equal, independent arrays", () => {
    const result = fullResult();
    const ids = fullFieldIds();
    const a = mapEnrichmentToCustomFields(result, ids);
    const b = mapEnrichmentToCustomFields(result, ids);
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    a.push({ id: "mutated", value: "x" });
    expect(b.some((v) => v.id === "mutated")).toBe(false);
  });
});

describe("buildLocationFieldIdMap", () => {
  it("maps jake_field_key → ghl_field_id", () => {
    const map = buildLocationFieldIdMap([
      { jake_field_key: "jake_owner_name", ghl_field_id: "cf_1" },
    ]);
    expect(map.get("jake_owner_name")).toBe("cf_1");
  });

  it("ignores rows with a blank key or id", () => {
    const map = buildLocationFieldIdMap([
      { jake_field_key: "", ghl_field_id: "cf_1" },
      { jake_field_key: "jake_owner_name", ghl_field_id: "" },
    ]);
    expect(map.size).toBe(0);
  });

  it("lets a later row win on a duplicate key", () => {
    const map = buildLocationFieldIdMap([
      { jake_field_key: "jake_owner_name", ghl_field_id: "old" },
      { jake_field_key: "jake_owner_name", ghl_field_id: "new" },
    ]);
    expect(map.get("jake_owner_name")).toBe("new");
  });
});

describe("no key drift from the canonical catalog", () => {
  it("has exactly one extractor per canonical field and vice versa", () => {
    const catalogKeys = [...JAKE_CUSTOM_FIELDS.map((f) => f.key)].sort();
    const extractorKeys = [...FIELD_VALUE_EXTRACTOR_KEYS].sort();
    expect(extractorKeys).toEqual(catalogKeys);
  });
});
