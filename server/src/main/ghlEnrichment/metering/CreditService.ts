import { inject, injectable } from "tsyringe";
import { GhlEnrichmentConfig } from "../config/GhlEnrichmentConfig";
import {
  CreditLedgerReason,
  EnrichmentCostPlan,
  enrichmentChargeLines,
  enrichmentCreditCost,
  textLookupChargeLines,
  textLookupCreditCost,
} from "./CreditCosts";
import { ChargeResult, CreditLedgerRow, CreditLedgerStore } from "./CreditLedgerStore";

/** A location's credit standing: current balance + recent ledger activity. */
export interface CreditAccountSummary {
  locationId: string;
  balance: number;
  recent: CreditLedgerRow[];
}

/**
 * Credit metering service (JAK-109) — the module's business surface.
 *
 * It sits between the enrichment worker and the {@link CreditLedgerStore}: it
 * turns an {@link EnrichmentCostPlan} into a price using the config-driven costs
 * ({@link GhlEnrichmentConfig.creditCosts}), answers "can this location afford
 * it?", performs the atomic charge on success, and exposes a simple read of the
 * balance + recent ledger (JAK-112 builds the real status view on top of this;
 * here we just provide the data + query method).
 *
 * Billing / Stripe top-ups are DEFERRED — for beta, credits are added via
 * {@link grantCredits} (manual grant). No enforcement of tiers here; just an
 * honest prepaid balance: never enrich for free, never half-charge.
 */
@injectable()
export class CreditService {
  constructor(
    @inject(CreditLedgerStore) private readonly ledger: CreditLedgerStore,
    @inject(GhlEnrichmentConfig) private readonly config: GhlEnrichmentConfig
  ) {}

  /** Total credits an enrichment with this plan will cost. */
  costOf(plan: EnrichmentCostPlan): number {
    return enrichmentCreditCost(this.config.creditCosts, plan);
  }

  /** Current spendable balance for a location (0 if it has none yet). */
  async getBalance(locationId: string): Promise<number> {
    return this.ledger.getBalance(locationId);
  }

  /** True if the location can currently afford an enrichment with this plan. */
  async hasSufficientCredits(locationId: string, plan: EnrichmentCostPlan): Promise<boolean> {
    const cost = this.costOf(plan);
    if (cost <= 0) return true;
    const balance = await this.ledger.getBalance(locationId);
    return balance >= cost;
  }

  /**
   * Charge a location for a completed enrichment, atomically. The charge is
   * itemized (a base `enrichment` line plus a `skip_trace` line when the plan
   * includes one) so the ledger shows exactly what was paid for. Returns the
   * store's {@link ChargeResult} — `ok:false` if the balance can't cover it
   * (e.g. a concurrent drain since the pre-check), never a partial charge.
   */
  async chargeForEnrichment(input: {
    locationId: string;
    contactId: string;
    plan: EnrichmentCostPlan;
  }): Promise<ChargeResult> {
    const lines = enrichmentChargeLines(this.config.creditCosts, input.plan);
    if (lines.length === 0) {
      // Nothing priced (all costs configured to 0) — treat as a free success.
      return { ok: true, balanceAfter: await this.ledger.getBalance(input.locationId), entries: [] };
    }
    return this.ledger.charge({
      locationId: input.locationId,
      contactId: input.contactId,
      lines,
    });
  }

  /**
   * Reverse the charge for a contact whose enrichment ultimately failed
   * (JAK-111 credit safety). Delegates to the ledger's compensating-entry path,
   * which is atomic AND idempotent: if the contact was never charged (or already
   * refunded) it's a no-op returning null, so the worker's dead-letter hook can
   * call it unconditionally. Never bill for a failed enrichment.
   */
  async refundEnrichment(input: {
    locationId: string;
    contactId: string;
    reason?: CreditLedgerReason;
  }): Promise<CreditLedgerRow | null> {
    return this.ledger.refund({
      locationId: input.locationId,
      contactId: input.contactId,
      reason: input.reason ?? "refund",
    });
  }

  // ── Tier-1 text-Jake (JAK-115) ────────────────────────────────────────────
  // Text-Jake bills the texting CUSTOMER (resolved by sender phone), not a GHL
  // location. The credit ledger keys on a generic account id, so we pass the
  // customer's stable credit-account id as that key. Distinct from enrichment:
  // there's no per-contact idempotency here — each inbound text is its own,
  // separately-billed lookup — so charges are NOT deduped by a reference id.

  /** Credits one text-Jake property lookup costs. */
  costOfTextLookup(): number {
    return textLookupCreditCost(this.config.creditCosts);
  }

  /** True if a customer's credit account can currently afford a text lookup. */
  async hasCreditsForTextLookup(accountId: string): Promise<boolean> {
    const cost = this.costOfTextLookup();
    if (cost <= 0) return true;
    return (await this.ledger.getBalance(accountId)) >= cost;
  }

  /**
   * Charge a customer's credit account for one delivered text-Jake lookup,
   * atomically. Returns the store's {@link ChargeResult} — `ok:false` if the
   * balance can't cover it (never a partial charge). No contact id is passed, so
   * repeat texts each bill independently (no enrichment-style dedup).
   */
  async chargeForTextLookup(input: { accountId: string }): Promise<ChargeResult> {
    const lines = textLookupChargeLines(this.config.creditCosts);
    if (lines.length === 0) {
      return { ok: true, balanceAfter: await this.ledger.getBalance(input.accountId), entries: [] };
    }
    return this.ledger.charge({ locationId: input.accountId, contactId: null, lines });
  }

  /**
   * Grant credits to a location (beta: manual top-up; also refunds/adjustments).
   * Atomic; returns the created ledger entry. Billing automation is deferred.
   */
  async grantCredits(
    locationId: string,
    amount: number,
    reason: CreditLedgerReason = "manual_grant"
  ): Promise<CreditLedgerRow> {
    return this.ledger.grant({ locationId, amount, reason });
  }

  /**
   * Simple internal read of a location's credit standing: balance + recent
   * ledger. The data source for the JAK-112 status view.
   */
  async getAccountSummary(locationId: string, recentLimit = 20): Promise<CreditAccountSummary> {
    const [balance, recent] = await Promise.all([
      this.ledger.getBalance(locationId),
      this.ledger.recentEntries(locationId, recentLimit),
    ]);
    return { locationId, balance, recent };
  }
}
