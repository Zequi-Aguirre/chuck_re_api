/**
 * Credit-cost model for enrichment operations (JAK-109).
 *
 * The per-operation costs are CONFIG-DRIVEN constants (sourced from Doppler via
 * {@link import("../config/GhlEnrichmentConfig").GhlEnrichmentConfig}), never
 * magic numbers sprinkled through the worker. This module is pure — no I/O — so
 * the pricing math is trivially testable and lives in exactly one place.
 *
 * The economics: enriching a record costs a base number of credits; a skip-trace
 * (owner contact lookup) costs EXTRA credits ON TOP of that base cost. A charge
 * is therefore expressed as one or more line items — one per priced operation —
 * so the ledger shows *what* was paid for, not just a lump sum.
 */

/** The tunable per-operation credit prices. All values are whole credits ≥ 0. */
export interface CreditCostConfig {
  /** Credits to enrich one record (property lookup + write-back). */
  enrichmentBaseCredits: number;
  /** EXTRA credits charged on top of the base cost when a skip-trace runs. */
  skipTraceCredits: number;
}

/**
 * What a single enrichment will do, priced up front. `skipTrace` is false on the
 * current worker path (the enrichment engine does not skip-trace yet); when that
 * operation is added, flipping this flag applies the extra cost automatically —
 * no other change to the metering path.
 */
export interface EnrichmentCostPlan {
  skipTrace: boolean;
}

/** Why a ledger entry exists. Mirrors the `reason` column on `credit_ledger`. */
export type CreditLedgerReason =
  | "enrichment"
  | "skip_trace"
  | "manual_grant"
  | "adjustment"
  // JAK-111: a compensating entry that reverses an enrichment charge when the
  // enrichment ultimately failed — we never bill for a failed enrichment.
  | "refund";

/** One priced operation within a charge — becomes one `credit_ledger` row. */
export interface CreditChargeLine {
  reason: CreditLedgerReason;
  /** Positive number of credits this line costs. */
  amount: number;
}

/** Safe defaults if config is ever absent: 1 per record, +2 for a skip-trace. */
export const DEFAULT_CREDIT_COSTS: CreditCostConfig = {
  enrichmentBaseCredits: 1,
  skipTraceCredits: 2,
};

/**
 * The itemized charge for an enrichment: always a base `enrichment` line, plus a
 * `skip_trace` line when the plan includes one. Zero-cost lines are dropped so a
 * price set to 0 never writes an empty ledger row.
 */
export function enrichmentChargeLines(
  costs: CreditCostConfig,
  plan: EnrichmentCostPlan
): CreditChargeLine[] {
  const lines: CreditChargeLine[] = [
    { reason: "enrichment", amount: costs.enrichmentBaseCredits },
  ];
  if (plan.skipTrace) {
    lines.push({ reason: "skip_trace", amount: costs.skipTraceCredits });
  }
  return lines.filter((line) => line.amount > 0);
}

/** Total credits an enrichment will cost — the sum of its charge lines. */
export function enrichmentCreditCost(
  costs: CreditCostConfig,
  plan: EnrichmentCostPlan
): number {
  return enrichmentChargeLines(costs, plan).reduce((sum, line) => sum + line.amount, 0);
}
