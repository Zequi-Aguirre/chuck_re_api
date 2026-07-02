import {
  CreditCostConfig,
  DEFAULT_CREDIT_COSTS,
  enrichmentChargeLines,
  enrichmentCreditCost,
} from "../CreditCosts";

const costs = (over: Partial<CreditCostConfig> = {}): CreditCostConfig => ({
  enrichmentBaseCredits: 1,
  skipTraceCredits: 2,
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

  it("ships sensible defaults (1 per record, +2 for skip-trace)", () => {
    expect(DEFAULT_CREDIT_COSTS).toEqual({ enrichmentBaseCredits: 1, skipTraceCredits: 2 });
  });
});
