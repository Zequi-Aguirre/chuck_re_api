import { inject, injectable } from "tsyringe";
import { GhlEnrichmentConfig } from "../config/GhlEnrichmentConfig";
import {
  CREDIT_TYPES,
  CreditLedgerReason,
  CreditType,
  EnrichmentCostPlan,
  enrichmentChargeLines,
  enrichmentCreditCost,
  textLookupChargeLines,
  textLookupCreditCost,
} from "./CreditCosts";
import { ChargeResult, CreditLedgerRow, CreditLedgerStore } from "./CreditLedgerStore";
import { CreditSettingsService } from "./CreditSettingsService";

/** A location's credit standing: current balance + recent ledger activity. */
export interface CreditAccountSummary {
  locationId: string;
  balance: number;
  recent: CreditLedgerRow[];
}

/** A customer's three independent per-feature balances (JAK-161). */
export type CreditBalances = Record<CreditType, number>;

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
    @inject(GhlEnrichmentConfig) private readonly config: GhlEnrichmentConfig,
    @inject(CreditSettingsService) private readonly creditSettings: CreditSettingsService
  ) {}

  /** Total credits an enrichment with this plan will cost. */
  costOf(plan: EnrichmentCostPlan): number {
    return enrichmentCreditCost(this.config.creditCosts, plan);
  }

  /**
   * Current spendable balance for an account in ONE bucket (0 if none yet).
   * Defaults to the REPORT bucket so pre-JAK-161 callers read what they always did.
   */
  async getBalance(locationId: string, type: CreditType = "report"): Promise<number> {
    return this.ledger.getBalance(locationId, type);
  }

  // ── Typed per-bucket API (JAK-161) ──────────────────────────────────────────
  // The three text-Jake features each check + charge ONLY their own bucket, so
  // one bucket running dry never affects the others. These are the generic
  // primitives; the feature-named wrappers below bind each path to its bucket.

  /** True if an account can afford `amount` in a given bucket (free when amount ≤ 0). */
  async hasCredits(accountId: string, type: CreditType, amount: number): Promise<boolean> {
    if (amount <= 0) return true;
    return (await this.ledger.getBalance(accountId, type)) >= amount;
  }

  /** Charge `amount` against ONE bucket, atomically. `reason` labels the ledger row. */
  async charge(
    accountId: string,
    type: CreditType,
    amount: number,
    reason: CreditLedgerReason
  ): Promise<ChargeResult> {
    if (amount <= 0) {
      return { ok: true, balanceAfter: await this.ledger.getBalance(accountId, type), entries: [] };
    }
    return this.ledger.charge({
      locationId: accountId,
      creditType: type,
      contactId: null,
      lines: [{ reason, amount }],
    });
  }

  /** Grant `amount` into ONE bucket, atomically. Returns the created ledger row. */
  async grant(
    accountId: string,
    type: CreditType,
    amount: number,
    reason: CreditLedgerReason = "manual_grant"
  ): Promise<CreditLedgerRow> {
    return this.ledger.grant({ locationId: accountId, creditType: type, amount, reason });
  }

  /**
   * Set ONE bucket to an exact `target` balance by granting or charging just the
   * DELTA (JAK-reset-credits-button). Reuses the atomic {@link grant}/{@link charge}
   * primitives — a shortfall is topped up, an excess is drawn back down — so the
   * ledger keeps a full audit trail either way. A no-op when the bucket is already
   * at `target`. `target` must be a non-negative integer; the draw-down removes at
   * most the current balance, so it can never overdraw. Returns the resulting
   * balance (always `target`).
   */
  async setBalance(
    accountId: string,
    type: CreditType,
    target: number,
    reason: CreditLedgerReason = "adjustment"
  ): Promise<number> {
    if (!Number.isInteger(target) || target < 0) {
      throw new Error("setBalance target must be a non-negative integer");
    }
    const current = await this.ledger.getBalance(accountId, type);
    const delta = target - current;
    if (delta > 0) {
      await this.grant(accountId, type, delta, reason);
    } else if (delta < 0) {
      await this.charge(accountId, type, -delta, reason);
    }
    return target;
  }

  /**
   * Reset ALL THREE of an account's buckets to the EFFECTIVE new-customer default
   * grants (JAK-reset-credits-button): report / skiptrace / comps from
   * {@link CreditSettingsService.defaultGrant} — the SAME admin-editable value
   * {@link seedNewCustomer} seeds a brand-new customer with (and the upcoming
   * monthly-restore worker will restore to), NOT the frozen
   * {@link CreditSettingsService.DEFAULT_GRANTS} code constant. So "reset to
   * default" always gives a customer exactly what a new customer currently gets:
   * if an admin retunes the defaults, reset honors the new value (today they're
   * still 50/10/10, so no behavior change). Each bucket is set via
   * {@link setBalance}, so an over-granted bucket is drawn back down and a
   * spent-out one is topped back up. Returns all three resulting balances. Not
   * atomic across buckets (mirrors {@link seedNewCustomer}); each set is
   * individually atomic.
   */
  async resetToDefaults(accountId: string): Promise<CreditBalances> {
    for (const type of CREDIT_TYPES) {
      const target = await this.creditSettings.defaultGrant(type);
      await this.setBalance(accountId, type, target, "adjustment");
    }
    return this.getBalances(accountId);
  }

  /** All three of an account's balances at once (JAK-161) — the per-feature view. */
  async getBalances(accountId: string): Promise<CreditBalances> {
    const entries = await Promise.all(
      CREDIT_TYPES.map(async (type) => [type, await this.ledger.getBalance(accountId, type)] as const)
    );
    return Object.fromEntries(entries) as CreditBalances;
  }

  /**
   * Seed a brand-new customer's three balances from the admin-editable defaults
   * (JAK-161): report / skiptrace / comps. Idempotent — a bucket that already has
   * a balance row is left untouched, so re-calling on an existing customer (or a
   * spent-down one) never re-grants. Safe on every customer-creation path.
   */
  async seedNewCustomer(accountId: string): Promise<void> {
    for (const type of CREDIT_TYPES) {
      const amount = await this.creditSettings.defaultGrant(type);
      await this.ledger.seedInitialBalance({
        locationId: accountId,
        creditType: type,
        amount,
        reason: "manual_grant",
      });
    }
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
      return { ok: true, balanceAfter: await this.ledger.getBalance(input.locationId, "report"), entries: [] };
    }
    // GHL-location enrichment lives entirely in the REPORT bucket (JAK-161) — its
    // single-pool behavior is unchanged; the two never diverge.
    return this.ledger.charge({
      locationId: input.locationId,
      creditType: "report",
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

  /** True if a customer's REPORT bucket can currently afford a text lookup. */
  async hasCreditsForTextLookup(accountId: string): Promise<boolean> {
    const cost = this.costOfTextLookup();
    if (cost <= 0) return true;
    return (await this.ledger.getBalance(accountId, "report")) >= cost;
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
      return { ok: true, balanceAfter: await this.ledger.getBalance(input.accountId, "report"), entries: [] };
    }
    return this.ledger.charge({ locationId: input.accountId, creditType: "report", contactId: null, lines });
  }

  // ── Text-Jake skip trace (JAK-136) ─────────────────────────────────────────
  // A skip trace hits the paid /v2/SkipTrace endpoint and costs MORE than a
  // report, so its price is a distinct, ADMIN-editable knob (SkipTraceSettingsService)
  // rather than a config constant — the caller passes the resolved cost in. Like
  // the text-lookup path it bills the texting CUSTOMER's credit account (by phone),
  // with no per-contact idempotency: each confirmed trace is its own billed action.

  /** True if a customer's SKIPTRACE bucket can afford a skip trace at `credits`. */
  async hasCreditsForSkipTrace(accountId: string, credits: number): Promise<boolean> {
    if (credits <= 0) return true;
    return (await this.ledger.getBalance(accountId, "skiptrace")) >= credits;
  }

  /**
   * Charge a customer's credit account for one delivered skip trace, atomically.
   * `credits` is the admin-configured skip-trace cost, recorded as a single
   * `skip_trace` ledger line. Returns the store's {@link ChargeResult} — `ok:false`
   * if the balance can't cover it (never a partial charge). No contact id, so
   * repeat traces each bill independently.
   */
  async chargeForSkipTrace(input: { accountId: string; credits: number }): Promise<ChargeResult> {
    if (input.credits <= 0) {
      return { ok: true, balanceAfter: await this.ledger.getBalance(input.accountId, "skiptrace"), entries: [] };
    }
    return this.ledger.charge({
      locationId: input.accountId,
      creditType: "skiptrace",
      contactId: null,
      lines: [{ reason: "skip_trace", amount: input.credits }],
    });
  }

  // ── Text-Jake comps (JAK-137) ──────────────────────────────────────────────
  // A comps pull hits the paid /v3/PropertyComps endpoint and costs MORE than a
  // report, so its price is a distinct, ADMIN-editable knob (CompsSettingsService)
  // rather than a config constant — the caller passes the resolved cost in. Like
  // the skip-trace path it bills the texting CUSTOMER's credit account (by phone),
  // with no per-contact idempotency: each confirmed comps pull is its own billed
  // action.

  /** True if a customer's COMPS bucket can afford a comps pull at `credits`. */
  async hasCreditsForComps(accountId: string, credits: number): Promise<boolean> {
    if (credits <= 0) return true;
    return (await this.ledger.getBalance(accountId, "comps")) >= credits;
  }

  /**
   * Charge a customer's credit account for one delivered comps pull, atomically.
   * `credits` is the admin-configured comps cost, recorded as a single `comps`
   * ledger line. Returns the store's {@link ChargeResult} — `ok:false` if the
   * balance can't cover it (never a partial charge). No contact id, so repeat
   * comps pulls each bill independently.
   */
  async chargeForComps(input: { accountId: string; credits: number }): Promise<ChargeResult> {
    if (input.credits <= 0) {
      return { ok: true, balanceAfter: await this.ledger.getBalance(input.accountId, "comps"), entries: [] };
    }
    return this.ledger.charge({
      locationId: input.accountId,
      creditType: "comps",
      contactId: null,
      lines: [{ reason: "comps", amount: input.credits }],
    });
  }

  /**
   * Grant credits to an account (beta: manual top-up; also refunds/adjustments).
   * Atomic; returns the created ledger entry. `type` selects the bucket — defaults
   * to REPORT so pre-JAK-161 callers (and the connection/enrichment grant path)
   * are unchanged; JAK-162's admin UI passes a specific bucket. Billing automation
   * is deferred.
   */
  async grantCredits(
    locationId: string,
    amount: number,
    reason: CreditLedgerReason = "manual_grant",
    type: CreditType = "report"
  ): Promise<CreditLedgerRow> {
    return this.ledger.grant({ locationId, creditType: type, amount, reason });
  }

  /**
   * Simple internal read of a location's REPORT credit standing: balance + recent
   * ledger. The data source for the JAK-112 status view (GHL locations only ever
   * use the report bucket).
   */
  async getAccountSummary(locationId: string, recentLimit = 20): Promise<CreditAccountSummary> {
    const [balance, recent] = await Promise.all([
      this.ledger.getBalance(locationId, "report"),
      this.ledger.recentEntries(locationId, recentLimit),
    ]);
    return { locationId, balance, recent };
  }
}
