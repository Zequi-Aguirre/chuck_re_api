import { RealEstateApiPropertySearchResult } from "../../../types/RealEstateApi";
import {
  CompsSelectionOptions,
  DEFAULT_SELECTION_OPTIONS,
  filterUsable,
  hardRejectReason,
  mapCandidate,
  mapSubject,
  selectDeterministic,
  toSelectedComp,
} from "../CompsSelectionTypes";

/**
 * JAK-164 — the PURE selection-engine core. These prove the numeric derivations
 * (sale price/date used, days on market, PPSF, haversine distance), every hard-reject
 * rule, the deterministic best-3 selection, and — per the JAK-164 addendum — that a
 * comp NEVER borrows the subject's price/date and a comp with no OWN price is dropped.
 */

const NOW = new Date("2026-07-06T00:00:00Z");
const OPTS: CompsSelectionOptions = { ...DEFAULT_SELECTION_OPTIONS, now: NOW };

// The subject at 358 Fernandina St NW — SFR, residential, 2,253 sqft, sold $844k.
const SUBJECT = mapSubject({
  id: "25599529",
  address: { house: "358", street: "Fernandina St Nw", city: "Palm Bay", state: "FL", zip: "32907", county: "Brevard County", fips: "12009" },
  latitude: 28.0124,
  longitude: -80.6795,
  propertyType: "SFR",
  landUse: "Residential",
  squareFeet: 2253,
  bedrooms: 4,
  bathrooms: 3,
  yearBuilt: 2004,
  lastSaleAmount: 844000,
  lastSaleDate: "2025-05-01",
});

/** A candidate ~0.3 mi away that sold recently on the DEED, with its own values. */
function candidate(over: Partial<RealEstateApiPropertySearchResult> = {}): RealEstateApiPropertySearchResult {
  return {
    id: "c1",
    address: { house: "366", street: "Fernandina St Nw", city: "Palm Bay", state: "FL", zip: "32907", county: "Brevard County", fips: "12009" },
    latitude: 28.0138,
    longitude: -80.6799,
    propertyType: "SFR",
    landUse: "Residential",
    bedrooms: 4,
    bathrooms: 3,
    squareFeet: 2200,
    lotSquareFeet: 10000,
    yearBuilt: 2003,
    lastSaleAmount: 430000,
    lastSaleDate: "2026-05-15",
    ...over,
  };
}

describe("mapCandidate — numeric derivations", () => {
  it("uses the DEED lastSaleAmount + date when there is no MLS sold price", () => {
    const c = mapCandidate(candidate(), SUBJECT);
    expect(c.salePriceUsed).toBe(430000);
    expect(c.priceSourceUsed).toBe("deed");
    expect(c.saleDateUsed).toBe("2026-05-15");
    // PPSF = 430000 / 2200 = 195.45 → 195
    expect(c.pricePerSquareFoot).toBe(195);
    // haversine distance is computed + present (well under a mile here).
    expect(c.distanceMiles).not.toBeNull();
    expect(c.distanceMiles!).toBeLessThan(0.2);
  });

  it("prefers MLS sold price + MLS sale date when BOTH are present", () => {
    const c = mapCandidate(
      candidate({ mlsSoldPrice: 455000, mlsLastSaleDate: "2026-06-01", mlsListingDate: "2026-05-02" }),
      SUBJECT
    );
    expect(c.salePriceUsed).toBe(455000);
    expect(c.priceSourceUsed).toBe("mls");
    expect(c.saleDateUsed).toBe("2026-06-01");
    // Days on market = 2026-05-02 → 2026-06-01 = 30 days.
    expect(c.daysOnMarket).toBe(30);
  });

  it("returns daysOnMarket null when either MLS date is missing (never fabricated)", () => {
    expect(mapCandidate(candidate({ mlsListingDate: "2026-05-02" }), SUBJECT).daysOnMarket).toBeNull();
    expect(mapCandidate(candidate({ mlsLastSaleDate: "2026-06-01" }), SUBJECT).daysOnMarket).toBeNull();
    expect(mapCandidate(candidate(), SUBJECT).daysOnMarket).toBeNull();
  });

  it("leaves salePriceUsed/PPSF null when the comp has no usable OWN price", () => {
    const c = mapCandidate(candidate({ lastSaleAmount: 0, mlsSoldPrice: null }), SUBJECT);
    expect(c.salePriceUsed).toBeNull();
    expect(c.priceSourceUsed).toBeNull();
    expect(c.pricePerSquareFoot).toBeNull();
  });
});

describe("hardRejectReason", () => {
  const reason = (over: Partial<RealEstateApiPropertySearchResult>) =>
    hardRejectReason(mapCandidate(candidate(over), SUBJECT), SUBJECT, OPTS);

  it("keeps a clean, nearby, recent, same-type comp", () => {
    expect(reason({})).toBeNull();
  });
  it("rejects a propertyType mismatch", () => {
    expect(reason({ propertyType: "CONDO" })).toBe("propertyType mismatch");
  });
  it("rejects a non-residential landUse when the subject is residential", () => {
    expect(reason({ landUse: "Commercial" })).toBe("non-residential landUse");
  });
  it("rejects a comp with no usable sale price", () => {
    expect(reason({ lastSaleAmount: 0, mlsSoldPrice: null })).toBe("no usable sale price");
  });
  it("rejects a comp with no usable sale date", () => {
    expect(reason({ lastSaleDate: null, lastSaleAmount: 430000 })).toBe("no usable sale date");
  });
  it("rejects a comp with missing/zero square feet", () => {
    expect(reason({ squareFeet: 0 })).toBe("squareFeet missing/zero");
  });
  it("rejects a comp beyond the 10-mile radius", () => {
    // ~30 miles north.
    expect(reason({ latitude: 28.45, longitude: -80.6799 })).toBe("distance > max radius");
  });
  it("rejects a sale older than the 365-day window", () => {
    expect(reason({ lastSaleDate: "2024-01-01" })).toBe("sale older than window");
  });
  it("rejects a comp whose square footage differs from the subject by more than 60%", () => {
    // subject 2253; 60% band is 901..3605. 5000 is out.
    expect(reason({ squareFeet: 5000 })).toBe("squareFeet differs > 60%");
  });
});

describe("selectDeterministic — best 3, honest limits, no bleed", () => {
  const raw = (id: string, over: Partial<RealEstateApiPropertySearchResult>) => candidate({ id, ...over });

  it("returns the best 3 (nearest-similar) and never more than the target", () => {
    const cands = [
      mapCandidate(raw("near", { latitude: 28.0130, longitude: -80.6796, lastSaleAmount: 435000 }), SUBJECT),
      mapCandidate(raw("mid", { latitude: 28.0300, longitude: -80.6799, lastSaleAmount: 440000 }), SUBJECT),
      mapCandidate(raw("far", { latitude: 28.0600, longitude: -80.6799, lastSaleAmount: 445000 }), SUBJECT),
      mapCandidate(raw("farther", { latitude: 28.0900, longitude: -80.6799, lastSaleAmount: 450000 }), SUBJECT),
    ];
    const picked = selectDeterministic(cands, SUBJECT, OPTS);
    expect(picked).toHaveLength(3);
    expect(picked[0]!.id).toBe("near"); // closest wins the top slot
  });

  it("returns FEWER than 3 when only 1 usable comp exists — never pads with rejects", () => {
    const cands = [
      mapCandidate(raw("good", {}), SUBJECT),
      mapCandidate(raw("noprice", { lastSaleAmount: 0, mlsSoldPrice: null }), SUBJECT),
      mapCandidate(raw("wrongtype", { propertyType: "LAND", landUse: "Vacant" }), SUBJECT),
    ];
    const picked = selectDeterministic(cands, SUBJECT, OPTS);
    expect(picked).toHaveLength(1);
    expect(picked[0]!.id).toBe("good");
  });

  it("ADDENDUM: a selected comp carries its OWN price/date, never the subject's $844k / date", () => {
    const cands = [mapCandidate(raw("c", { lastSaleAmount: 430000, lastSaleDate: "2026-05-15" }), SUBJECT)];
    const [sel] = selectDeterministic(cands, SUBJECT, OPTS).map(toSelectedComp);
    expect(sel!.salePriceUsed).toBe(430000);
    expect(sel!.salePriceUsed).not.toBe(SUBJECT!.lastSalePrice); // not 844000
    expect(sel!.saleDateUsed).toBe("2026-05-15");
    expect(sel!.saleDateUsed).not.toBe(SUBJECT!.lastSaleDate);
  });

  it("ADDENDUM: a comp with no OWN price is dropped by filterUsable, not shown", () => {
    const cands = [mapCandidate(raw("noprice", { lastSaleAmount: 0, mlsSoldPrice: null }), SUBJECT)];
    expect(filterUsable(cands, SUBJECT, OPTS)).toHaveLength(0);
    expect(selectDeterministic(cands, SUBJECT, OPTS)).toHaveLength(0);
  });

  it("degrades gracefully: zoning + censusTract are null (not shipped by PropertySearch)", () => {
    const sel = toSelectedComp(mapCandidate(candidate(), SUBJECT));
    expect(sel.zoning).toBeUndefined();
    expect(sel.censusTract).toBeUndefined();
    expect(sel.fips).toBe("12009");
  });
});
