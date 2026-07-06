import {
  DEFAULT_COMP_PARAMS,
  assembleCompsData,
  clampCompParams,
  compsCacheKey,
  formatCompParams,
  hasComps,
  parseStoredCompParams,
  resolveCompParams,
} from "../CompsTypes";
import { RealEstateApiPropertyCompsResponse } from "../../../types/RealEstateApi";

/**
 * JAK-137 — the pure comps params + assembly layer. These pin the three behaviors
 * Zequi asked for: admin DEFAULTS, texter OVERRIDES, and CLAMPING; plus the pure
 * response assembler (tolerance filtering, capping, derived average/range) that the
 * writer consumes, and the params-aware cache key.
 */
describe("CompsTypes (JAK-137)", () => {
  describe("params defaults / overrides / clamping", () => {
    it("clamps every parameter to its sane bounds", () => {
      const clamped = clampCompParams({
        radiusMiles: 500,
        count: 999,
        monthsBack: 999,
        bedsTolerance: 50,
        bathsTolerance: -5,
        sqftTolerancePct: 500,
      });
      expect(clamped).toEqual({
        radiusMiles: 10,
        count: 10,
        monthsBack: 24,
        bedsTolerance: 3,
        bathsTolerance: 0,
        sqftTolerancePct: 100,
      });
    });

    it("resolveCompParams starts from the defaults and applies only supplied overrides", () => {
      const resolved = resolveCompParams(DEFAULT_COMP_PARAMS, { radiusMiles: 1, count: 3 });
      expect(resolved).toEqual({ ...DEFAULT_COMP_PARAMS, radiusMiles: 1, count: 3 });
    });

    it("resolveCompParams ignores non-numeric overrides and clamps the result", () => {
      const resolved = resolveCompParams(DEFAULT_COMP_PARAMS, {
        radiusMiles: 500,
        // @ts-expect-error — a stray non-number is ignored, not applied.
        count: "lots",
      });
      expect(resolved.radiusMiles).toBe(10); // clamped
      expect(resolved.count).toBe(DEFAULT_COMP_PARAMS.count); // untouched
    });

    it("resolveCompParams with no overrides returns the (clamped) defaults", () => {
      expect(resolveCompParams(DEFAULT_COMP_PARAMS, null)).toEqual(DEFAULT_COMP_PARAMS);
    });

    it("parseStoredCompParams fills gaps from the default and returns null on junk", () => {
      expect(parseStoredCompParams(JSON.stringify({ count: 3 }))).toEqual({ ...DEFAULT_COMP_PARAMS, count: 3 });
      expect(parseStoredCompParams("not json")).toBeNull();
      expect(parseStoredCompParams(null)).toBeNull();
    });

    it("formatCompParams states radius, count, timeframe, and tolerances", () => {
      const summary = formatCompParams(DEFAULT_COMP_PARAMS);
      expect(summary).toContain("radius 1 mi");
      expect(summary).toContain("up to 5 comps");
      expect(summary).toContain("last 12 months");
      expect(summary).toContain("beds ±1");
      expect(summary).toContain("sqft ±25%");
    });
  });

  describe("compsCacheKey", () => {
    it("folds the address + parameter signature; different params → different key", () => {
      const a = compsCacheKey("  742 Evergreen   Terrace ", DEFAULT_COMP_PARAMS);
      const b = compsCacheKey("742 evergreen terrace", DEFAULT_COMP_PARAMS);
      // Casing/spacing normalize to the same key.
      expect(a).toBe(b);
      // A different param-set is a different request.
      expect(compsCacheKey("742 Evergreen Terrace", { ...DEFAULT_COMP_PARAMS, count: 3 })).not.toBe(a);
    });
  });

  describe("assembleCompsData", () => {
    // JAK-160: subject + comps carry lat/long so the assembler computes REAL
    // great-circle distances and orders nearest-first. Subject at (28.0000,
    // -80.6000); the "Close" comp is deliberately listed BEFORE the nearer
    // "Nearby" comp so the sort has to reorder them.
    const response: RealEstateApiPropertyCompsResponse = {
      subject: { bedrooms: 3, bathrooms: 2, squareFeet: 1500, latitude: 28.0, longitude: -80.6 },
      comps: [
        // ~0.61 mi east (0.01 deg lon at this latitude).
        { address: "456 Close Ave", lastSaleAmount: 420000, bedrooms: 3, bathrooms: 2, squareFeet: 1600, latitude: 28.0, longitude: -80.61, yearBuilt: "1998" },
        // ~0.31 mi east (0.005 deg lon) — the genuinely nearest, plus MLS DOM.
        { address: "123 Nearby St", lastSaleAmount: 400000, bedrooms: 3, bathrooms: 2, squareFeet: 1550, latitude: 28.0, longitude: -80.605, yearBuilt: "2004", mlsDaysOnMarket: "12", lastSaleDate: "2026-03-01" },
        // Way off on beds → filtered out by the default ±1 bed tolerance.
        { address: "789 Far Rd", lastSaleAmount: 999000, bedrooms: 8, bathrooms: 2, squareFeet: 1500, latitude: 28.0, longitude: -80.6 },
      ],
      reapiAvm: 410000,
      reapiAvmLow: 395000,
      reapiAvmHigh: 430000,
    };

    it("maps present values, filters by tolerance, orders nearest-first, and derives the average + range", () => {
      const data = assembleCompsData(response, "742 Evergreen Terrace", DEFAULT_COMP_PARAMS);

      // The 8-bed outlier is filtered; the two in-tolerance comps remain, and the
      // genuinely-nearest comp is sorted FIRST despite being listed second.
      expect(data.comps).toHaveLength(2);
      expect(data.comps[0].address).toBe("123 Nearby St");
      expect(data.comps[1].address).toBe("456 Close Ave");
      // Nearest-first: comp[0]'s distance is smaller than comp[1]'s.
      expect(data.comps[0].distanceMiles!).toBeLessThan(data.comps[1].distanceMiles!);
      expect(data.comps[0].distanceMiles!).toBeGreaterThan(0.25);
      expect(data.comps[0].distanceMiles!).toBeLessThan(0.4);
      // yearBuilt coerced string -> number; mlsDaysOnMarket mapped as daysOnMarket.
      expect(data.comps[0].yearBuilt).toBe(2004);
      expect(data.comps[0].daysOnMarket).toBe(12);
      expect(data.comps[0].saleDate).toBe("03/01/2026");
      // The farther comp: yearBuilt present, but no DOM (non-MLS) — omitted, no blank.
      expect(data.comps[1].yearBuilt).toBe(1998);
      expect(data.comps[1].daysOnMarket).toBeUndefined();
      // Derived only from the included comps.
      expect(data.averageSalePrice).toBe(410000);
      expect(data.estimatedValueLow).toBe(395000);
      expect(data.estimatedValueHigh).toBe(430000);
      expect(data.subjectAddress).toBe("742 Evergreen Terrace");
      expect(hasComps(data)).toBe(true);
    });

    it("omits distance when a comp lacks coordinates, and sorts such comps last", () => {
      const mixed: RealEstateApiPropertyCompsResponse = {
        subject: { bedrooms: 3, bathrooms: 2, squareFeet: 1500, latitude: 28.0, longitude: -80.6 },
        comps: [
          // No coords → no distance, sorts LAST even though listed first.
          { address: "No Coords Rd", lastSaleAmount: 300000, bedrooms: 3, bathrooms: 2, squareFeet: 1500 },
          // Has coords → gets a distance, sorts first.
          { address: "Has Coords Ln", lastSaleAmount: 310000, bedrooms: 3, bathrooms: 2, squareFeet: 1500, latitude: 28.0, longitude: -80.605 },
        ],
      };
      const data = assembleCompsData(mixed, "1 A St", DEFAULT_COMP_PARAMS);
      expect(data.comps.map((c) => c.address)).toEqual(["Has Coords Ln", "No Coords Rd"]);
      expect(data.comps[0].distanceMiles).toBeGreaterThan(0);
      expect(data.comps[1].distanceMiles).toBeUndefined();
    });

    it("computes no distance at all when the subject has no coordinates", () => {
      const noSubjectCoords: RealEstateApiPropertyCompsResponse = {
        subject: { bedrooms: 3, bathrooms: 2, squareFeet: 1500 },
        comps: [{ address: "1 St", lastSaleAmount: 100000, latitude: 28.0, longitude: -80.605 }],
      };
      const data = assembleCompsData(noSubjectCoords, "1 A St", DEFAULT_COMP_PARAMS);
      expect(data.comps[0].distanceMiles).toBeUndefined();
    });

    it("takes the CLOSEST params.count comps, not just the first count returned", () => {
      // Five comps at increasing distance, listed farthest-first; count=3 must keep
      // the three NEAREST (0.31, 0.61, 0.92 mi), dropping the two farthest.
      const many: RealEstateApiPropertyCompsResponse = {
        subject: { bedrooms: 3, bathrooms: 2, squareFeet: 1500, latitude: 28.0, longitude: -80.6 },
        comps: [
          { address: "E far", lastSaleAmount: 5, bedrooms: 3, bathrooms: 2, squareFeet: 1500, latitude: 28.0, longitude: -80.625 },
          { address: "D", lastSaleAmount: 4, bedrooms: 3, bathrooms: 2, squareFeet: 1500, latitude: 28.0, longitude: -80.62 },
          { address: "C", lastSaleAmount: 3, bedrooms: 3, bathrooms: 2, squareFeet: 1500, latitude: 28.0, longitude: -80.615 },
          { address: "B", lastSaleAmount: 2, bedrooms: 3, bathrooms: 2, squareFeet: 1500, latitude: 28.0, longitude: -80.61 },
          { address: "A near", lastSaleAmount: 1, bedrooms: 3, bathrooms: 2, squareFeet: 1500, latitude: 28.0, longitude: -80.605 },
        ],
      };
      const data = assembleCompsData(many, "1 A St", { ...DEFAULT_COMP_PARAMS, count: 3 });
      expect(data.comps.map((c) => c.address)).toEqual(["A near", "B", "C"]);
    });

    it("caps the number of comps at params.count", () => {
      const many: RealEstateApiPropertyCompsResponse = {
        comps: Array.from({ length: 8 }, (_, i) => ({ address: `${i} St`, lastSaleAmount: 100000 + i })),
      };
      const data = assembleCompsData(many, "1 A St", { ...DEFAULT_COMP_PARAMS, count: 3 });
      expect(data.comps).toHaveLength(3);
    });

    it("reads comps from `data` when `comps` is absent, and handles an empty response", () => {
      const viaData = assembleCompsData({ data: [{ address: "1 St", lastSaleAmount: 1 }] }, "1 A St", DEFAULT_COMP_PARAMS);
      expect(viaData.comps).toHaveLength(1);

      const empty = assembleCompsData(null, "1 A St", DEFAULT_COMP_PARAMS);
      expect(empty.comps).toEqual([]);
      expect(hasComps(empty)).toBe(false);
      // Still carries the parameters for the reply.
      expect(empty.paramsSummary).toBe(formatCompParams(DEFAULT_COMP_PARAMS));
    });

    it("JAK-144: coerces the provider's string numerics and omits a $0 sale price", () => {
      // Real (representative) shape: the provider ships comp numerics as strings, and
      // some records carry lastSaleAmount "0" (no usable sale price).
      const realShaped = {
        subject: { bedrooms: 4, bathrooms: 3, squareFeet: 2253 },
        comps: [
          { address: { street: "489 Freeman Rd Nw", city: "Palm Bay", state: "FL", zip: "32907" }, lastSaleAmount: "250000", bedrooms: "4", bathrooms: 2, squareFeet: "2083", lastSaleDate: "2026-06-10" },
          { address: { street: "238 Peckham St Ne", city: "Palm Bay", state: "FL", zip: "32907" }, lastSaleAmount: "0", bedrooms: "4", squareFeet: "2141" },
        ],
        reapiAvm: 356000,
      } as unknown as RealEstateApiPropertyCompsResponse;

      const data = assembleCompsData(realShaped, "358 Fernandina St Nw, Palm Bay, FL 32907", DEFAULT_COMP_PARAMS);

      expect(data.comps).toHaveLength(2);
      // String numerics coerced to numbers; structured address rendered to a line.
      expect(data.comps[0]).toEqual({
        address: "489 Freeman Rd Nw, Palm Bay FL 32907",
        salePrice: 250000,
        beds: 4,
        baths: 2,
        squareFeet: 2083,
        saleDate: "06/10/2026",
      });
      // The "0" sale price is omitted (never rendered as $0), but the comp is kept.
      expect(data.comps[1].salePrice).toBeUndefined();
      expect(data.comps[1].address).toBe("238 Peckham St Ne, Palm Bay FL 32907");
      // Average derives only from the comp that had a real price.
      expect(data.averageSalePrice).toBe(250000);
      expect(data.estimatedValue).toBe(356000);
      expect(hasComps(data)).toBe(true);
    });
  });
});
