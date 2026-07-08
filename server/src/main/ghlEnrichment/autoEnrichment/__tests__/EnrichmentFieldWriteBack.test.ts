/**
 * JAK-185 — GHL custom-field write-back tests.
 *
 * All GHL calls are MOCKED — no real outbound to GHL (hard rule). Covers:
 *   - the name → id matching (auto-discovery), incl. casing/whitespace tolerance
 *   - the overwrite payload shape (targeted by id)
 *   - graceful skip for a missing field (Eric hasn't created it yet)
 *   - the per-location cache + demand-driven refetch when a name is missing
 *   - the catalog/formatter drift guard
 */
import { EnrichmentFieldWriteBackService } from "../EnrichmentFieldWriteBackService";
import { GhlEnrichmentFieldResolver } from "../GhlEnrichmentFieldResolver";
import {
  AUTO_ENRICHMENT_FIELDS,
  normalizeFieldName,
} from "../AutoEnrichmentFieldCatalog";
import { AutoEnrichmentFields } from "../AutoEnrichmentTypes";
import { GhlApiClient } from "../../api/GhlApiClient";
import { GhlCustomField } from "../../api/GhlApiTypes";

/** Build a fake GHL custom-field catalog: one field per catalog entry, id = `id-<name>`. */
const fullCatalog = (): GhlCustomField[] =>
  AUTO_ENRICHMENT_FIELDS.map((def) => ({ id: `id-${def.name}`, name: def.name }));

/** A mock GhlApiClient exposing just the two methods the write-back path uses. */
const makeApi = (catalog: GhlCustomField[] = fullCatalog()) => {
  const listCustomFields = jest.fn<Promise<GhlCustomField[]>, [string]>(
    async () => catalog
  );
  const updateContactCustomFields = jest.fn<Promise<void>, unknown[]>(
    async () => undefined
  );
  const api = { listCustomFields, updateContactCustomFields } as unknown as GhlApiClient;
  return { api, listCustomFields, updateContactCustomFields };
};

/** A representative, fully-populated formatter result. */
const fullFields = (overrides: Partial<AutoEnrichmentFields> = {}): AutoEnrichmentFields => ({
  dealSignals: "Pre-Foreclosure\nHigh Equity",
  mlsStatus: "Off Market",
  propertyType: "SFR",
  estimatedEquity: 275000,
  equityPercent: 62,
  estimatedValue: 440000,
  mortgageBalance: 165000,
  monthlyMortgage: 1450,
  ownerOfRecord: "Jane Q. Homeowner",
  yearsOwned: "15.2 Years",
  beds: 3,
  baths: 2,
  sqFt: 1850,
  lotSize: 7200,
  yearBuilt: 1998,
  lastSaleDate: "2011-05-01",
  lastSalePrice: 210000,
  propertyAddress: "123 Main St, Austin, TX 78701",
  ...overrides,
});

const makeService = (catalog?: GhlCustomField[]) => {
  const mock = makeApi(catalog);
  const resolver = new GhlEnrichmentFieldResolver(mock.api);
  const service = new EnrichmentFieldWriteBackService(mock.api, resolver);
  return { service, resolver, ...mock };
};

beforeEach(() => jest.restoreAllMocks());

describe("catalog", () => {
  it("has exactly one entry per AutoEnrichmentFields value key (no drift)", () => {
    // The formatter's output keys, sampled from a full result.
    const formatterKeys = Object.keys(fullFields()).sort();
    const catalogKeys = AUTO_ENRICHMENT_FIELDS.map((f) => f.key).sort();
    expect(catalogKeys).toEqual(formatterKeys);
  });

  it("maps to the 18 confirmed GHL display names", () => {
    expect(AUTO_ENRICHMENT_FIELDS.map((f) => f.name)).toEqual([
      "Jake Deal Signals",
      "MLS Status",
      "Property Type",
      "Estimated Equity",
      "Equity %",
      "Estimated Value",
      "Mortgage Balance",
      "Monthly Mortgage",
      "Owner of Record",
      "Years Owned",
      "Beds",
      "Baths",
      "Sq Ft",
      "Lot Size",
      "Year Built",
      "Last Sale Date",
      "Last Sale Price",
      "Property Address",
    ]);
  });

  it("has no duplicate display names", () => {
    const names = AUTO_ENRICHMENT_FIELDS.map((f) => normalizeFieldName(f.name));
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("writeEnrichmentFields — name→id matching + overwrite payload", () => {
  it("resolves every field by name and writes one {id, value} per field", async () => {
    const { service, updateContactCustomFields } = makeService();
    const result = await service.writeEnrichmentFields("loc_1", "contact_1", fullFields());

    expect(result.didWrite).toBe(true);
    expect(result.written).toHaveLength(AUTO_ENRICHMENT_FIELDS.length);
    expect(result.skipped).toEqual([]);

    expect(updateContactCustomFields).toHaveBeenCalledTimes(1);
    const [locationId, contactId, customFields] = updateContactCustomFields.mock.calls[0];
    expect(locationId).toBe("loc_1");
    expect(contactId).toBe("contact_1");
    // Targeted by id (overwrite), value carried straight from the formatter.
    expect(customFields).toContainEqual({ id: "id-Jake Deal Signals", value: "Pre-Foreclosure\nHigh Equity" });
    expect(customFields).toContainEqual({ id: "id-Estimated Equity", value: 275000 });
    expect(customFields).toContainEqual({ id: "id-MLS Status", value: "Off Market" });
    // Every entry targets by id (never by key/name), and nothing is null.
    for (const cf of customFields as Array<{ id?: string; value: unknown }>) {
      expect(typeof cf.id).toBe("string");
      expect(cf.value).not.toBeNull();
    }
  });

  it("matches names case- and whitespace-insensitively", async () => {
    const scrambled: GhlCustomField[] = AUTO_ENRICHMENT_FIELDS.map((def) => ({
      id: `id-${def.key}`,
      name: `  ${def.name.toUpperCase()}  `,
    }));
    const { service, updateContactCustomFields } = makeService(scrambled);
    const result = await service.writeEnrichmentFields("loc_1", "c1", fullFields());

    expect(result.skipped).toEqual([]);
    const [, , customFields] = updateContactCustomFields.mock.calls[0];
    expect(customFields).toContainEqual({ id: "id-propertyType", value: "SFR" });
  });

  it("only writes fields the formatter produced (omitted → left untouched)", async () => {
    const { service, updateContactCustomFields } = makeService();
    // A sparse result: mlsStatus is always present; add just two more.
    const result = await service.writeEnrichmentFields("loc_1", "c1", {
      mlsStatus: "Listed",
      propertyType: "Condo",
      beds: 2,
    });

    expect(result.written.sort()).toEqual(["Beds", "MLS Status", "Property Type"]);
    const [, , customFields] = updateContactCustomFields.mock.calls[0];
    expect(customFields).toHaveLength(3);
    expect(customFields).toContainEqual({ id: "id-MLS Status", value: "Listed" });
    expect(customFields).toContainEqual({ id: "id-Beds", value: 2 });
  });

  it("keeps a legitimate zero / empty-ish value (only undefined is skipped)", async () => {
    const { service, updateContactCustomFields } = makeService();
    await service.writeEnrichmentFields("loc_1", "c1", {
      mlsStatus: "Off Market",
      estimatedEquity: 0,
    });
    const [, , customFields] = updateContactCustomFields.mock.calls[0];
    expect(customFields).toContainEqual({ id: "id-Estimated Equity", value: 0 });
  });
});

describe("writeEnrichmentFields — graceful missing-field skip", () => {
  it("skips (logs) a spec field with no matching GHL field, writes the rest", async () => {
    // Catalog missing "Estimated Equity".
    const partial = fullCatalog().filter((f) => f.name !== "Estimated Equity");
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    const { service, updateContactCustomFields } = makeService(partial);

    const result = await service.writeEnrichmentFields("loc_1", "c1", fullFields());

    expect(result.didWrite).toBe(true);
    expect(result.skipped).toEqual(["Estimated Equity"]);
    expect(result.written).toContain("MLS Status");
    const [, , customFields] = updateContactCustomFields.mock.calls[0];
    expect(customFields).not.toContainEqual(
      expect.objectContaining({ value: 275000 })
    );
    expect(warn).toHaveBeenCalled();
  });

  it("skips the write call entirely when NO field resolves", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    const { service, updateContactCustomFields } = makeService([]); // empty catalog
    const result = await service.writeEnrichmentFields("loc_1", "c1", fullFields());

    expect(result.didWrite).toBe(false);
    expect(result.written).toEqual([]);
    expect(result.skipped.length).toBe(AUTO_ENRICHMENT_FIELDS.length);
    expect(updateContactCustomFields).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it("no-ops on an empty formatter result (nothing to write, no fetch)", async () => {
    const { service, updateContactCustomFields, listCustomFields } = makeService();
    const result = await service.writeEnrichmentFields(
      "loc_1",
      "c1",
      {} as AutoEnrichmentFields
    );
    expect(result).toEqual({ written: [], skipped: [], didWrite: false });
    expect(updateContactCustomFields).not.toHaveBeenCalled();
    expect(listCustomFields).not.toHaveBeenCalled();
  });
});

describe("per-location cache + demand-driven refetch", () => {
  it("caches the catalog per location — a second write does not refetch", async () => {
    const { service, listCustomFields } = makeService();
    await service.writeEnrichmentFields("loc_1", "c1", fullFields());
    await service.writeEnrichmentFields("loc_1", "c2", fullFields());
    expect(listCustomFields).toHaveBeenCalledTimes(1);
  });

  it("fetches independently per location", async () => {
    const { service, listCustomFields } = makeService();
    await service.writeEnrichmentFields("loc_1", "c1", fullFields());
    await service.writeEnrichmentFields("loc_2", "c1", fullFields());
    expect(listCustomFields).toHaveBeenCalledTimes(2);
    expect(listCustomFields).toHaveBeenCalledWith("loc_1");
    expect(listCustomFields).toHaveBeenCalledWith("loc_2");
  });

  it("refetches ONCE on a cached miss when the field appears (Eric added it since)", async () => {
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
    // Fetch #1: catalog WITHOUT "Property Type". Fetch #2: full (Eric added it).
    const partial = fullCatalog().filter((f) => f.name !== "Property Type");
    const catalogs = [partial, fullCatalog()];
    const listCustomFields = jest
      .fn<Promise<GhlCustomField[]>, [string]>()
      .mockImplementation(async () => catalogs.shift() ?? fullCatalog());
    const updateContactCustomFields = jest.fn(async () => undefined);
    const api = { listCustomFields, updateContactCustomFields } as unknown as GhlApiClient;
    const service = new EnrichmentFieldWriteBackService(
      api,
      new GhlEnrichmentFieldResolver(api)
    );

    // Call 1: cold fetch of the partial catalog — a fresh fetch is trusted as-is,
    // so "Property Type" is skipped this run (no same-call refetch).
    const first = await service.writeEnrichmentFields("loc_1", "c1", fullFields());
    expect(first.skipped).toEqual(["Property Type"]);
    expect(listCustomFields).toHaveBeenCalledTimes(1);

    // Call 2: the CACHED map misses "Property Type" → one refetch, which now
    // finds it (Eric created it). Nothing skipped.
    const second = await service.writeEnrichmentFields("loc_1", "c2", fullFields());
    expect(second.skipped).toEqual([]);
    expect(listCustomFields).toHaveBeenCalledTimes(2);

    // Call 3: cached with the full catalog → no further refetch.
    await service.writeEnrichmentFields("loc_1", "c3", fullFields());
    expect(listCustomFields).toHaveBeenCalledTimes(2);
  });

  it("does not refetch when a genuinely-absent field just stays missing", async () => {
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
    const partial = fullCatalog().filter((f) => f.name !== "Lot Size");
    const listCustomFields = jest
      .fn<Promise<GhlCustomField[]>, [string]>()
      .mockResolvedValue(partial);
    const api = {
      listCustomFields,
      updateContactCustomFields: jest.fn(async () => undefined),
    } as unknown as GhlApiClient;
    const service = new EnrichmentFieldWriteBackService(
      api,
      new GhlEnrichmentFieldResolver(api)
    );

    // First write: cold cache → 1 fetch; "Lot Size" missing but a fresh fetch is
    // trusted, so no second fetch this call.
    const first = await service.writeEnrichmentFields("loc_1", "c1", fullFields());
    expect(first.skipped).toEqual(["Lot Size"]);
    expect(listCustomFields).toHaveBeenCalledTimes(1);

    // Second write: cached map still misses "Lot Size" → one refetch (still gone).
    const second = await service.writeEnrichmentFields("loc_1", "c2", fullFields());
    expect(second.skipped).toEqual(["Lot Size"]);
    expect(listCustomFields).toHaveBeenCalledTimes(2);
  });

  it("invalidate() drops the cache so the next resolve refetches", async () => {
    const { service, resolver, listCustomFields } = makeService();
    await service.writeEnrichmentFields("loc_1", "c1", fullFields());
    resolver.invalidate("loc_1");
    await service.writeEnrichmentFields("loc_1", "c2", fullFields());
    expect(listCustomFields).toHaveBeenCalledTimes(2);
  });
});
