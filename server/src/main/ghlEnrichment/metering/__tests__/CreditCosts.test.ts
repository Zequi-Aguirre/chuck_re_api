import {
  CreditCostConfig,
  DEFAULT_CREDIT_COSTS,
  enrichmentChargeLines,
  enrichmentCreditCost,
  textLookupChargeLines,
  textLookupCreditCost,
} from "../CreditCosts";

const costs = (over: Partial<CreditCostConfig> = {}): CreditCostConfig => ({
  enrichmentBaseCredits: 1,
  skipTraceCredits: 2,
  textLookupCredits: 1,
  ...over,
});

describe("CreditCosts", () => {
  describe("enrichmentChargeLines", () => {
    it("charges just the base enrichment line without a skip-trace", () => {
      expect(enrichmentChargeLines(costs(), { skipTrace: false })).toEqual([
        { reason: "enrichment", amount: 1 },
      ]);
    });

    it("adds a separate skip_trace line on top of the base when skip-tracing", () => {
      expect(enrichmentChargeLines(costs(), { skipTrace: true })).toEqual([
        { reason: "enrichment", amount: 1 },
        { reason: "skip_trace", amount: 2 },
      ]);
    });

    it("drops zero-cost lines so an empty ledger row is never written", () => {
      const free = costs({ enrichmentBaseCredits: 0, skipTraceCredits: 0 });
      expect(enrichmentChargeLines(free, { skipTrace: true })).toEqual([]);
    });
  });

  describe("enrichmentCreditCost", () => {
    it("is the base cost without a skip-trace", () => {
      expect(enrichmentCreditCost(costs(), { skipTrace: false })).toBe(1);
    });

    it("is base + extra WITH a skip-trace (extra is on top, not instead)", () => {
      expect(enrichmentCreditCost(costs(), { skipTrace: true })).toBe(3);
    });

    it("honors config-driven prices, not magic numbers", () => {
      const pricey = costs({ enrichmentBaseCredits: 5, skipTraceCredits: 10 });
      expect(enrichmentCreditCost(pricey, { skipTrace: true })).toBe(15);
    });
  });

  describe("textLookupChargeLines / textLookupCreditCost (JAK-115)", () => {
    it("charges a single text_lookup line at the configured price", () => {
      expect(textLookupChargeLines(costs({ textLookupCredits: 2 }))).toEqual([
        { reason: "text_lookup", amount: 2 },
      ]);
      expect(textLookupCreditCost(costs({ textLookupCredits: 2 }))).toBe(2);
    });

    it("drops the line when priced at 0 (never an empty ledger row)", () => {
      expect(textLookupChargeLines(costs({ textLookupCredits: 0 }))).toEqual([]);
      expect(textLookupCreditCost(costs({ textLookupCredits: 0 }))).toBe(0);
    });
  });

  it("ships sensible defaults (1 per record, +2 for skip-trace, 1 per text lookup)", () => {
    expect(DEFAULT_CREDIT_COSTS).toEqual({
      enrichmentBaseCredits: 1,
      skipTraceCredits: 2,
      textLookupCredits: 1,
    });
  });
});
