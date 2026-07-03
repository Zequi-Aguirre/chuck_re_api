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
    const response: RealEstateApiPropertyCompsResponse = {
      subject: { bedrooms: 3, bathrooms: 2, squareFeet: 1500 },
      comps: [
        { address: "123 Nearby St", lastSaleAmount: 400000, bedrooms: 3, bathrooms: 2, squareFeet: 1550, distance: 0.4, lastSaleDate: "2026-03-01" },
        { address: "456 Close Ave", lastSaleAmount: 420000, bedrooms: 3, bathrooms: 2, squareFeet: 1600 },
        // Way off on beds → filtered out by the default ±1 bed tolerance.
        { address: "789 Far Rd", lastSaleAmount: 999000, bedrooms: 8, bathrooms: 2, squareFeet: 1500 },
      ],
      reapiAvm: 410000,
      reapiAvmLow: 395000,
      reapiAvmHigh: 430000,
    };

    it("maps only present values, filters by tolerance, caps at count, and derives the average + range", () => {
      const data = assembleCompsData(response, "742 Evergreen Terrace", DEFAULT_COMP_PARAMS);

      // The 8-bed outlier is filtered; the two in-tolerance comps remain.
      expect(data.comps).toHaveLength(2);
      expect(data.comps[0]).toEqual({
        address: "123 Nearby St",
        salePrice: 400000,
        beds: 3,
        baths: 2,
        squareFeet: 1550,
        distanceMiles: 0.4,
        saleDate: "03/01/2026",
      });
      // The second comp omits distance/date it never had — no blanks.
      expect(data.comps[1]).toEqual({ address: "456 Close Ave", salePrice: 420000, beds: 3, baths: 2, squareFeet: 1600 });
      // Derived only from the included comps.
      expect(data.averageSalePrice).toBe(410000);
      expect(data.estimatedValueLow).toBe(395000);
      expect(data.estimatedValueHigh).toBe(430000);
      expect(data.subjectAddress).toBe("742 Evergreen Terrace");
      expect(hasComps(data)).toBe(true);
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
  });
});
