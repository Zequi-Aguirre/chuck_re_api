import { injectable } from "tsyringe";
import { CreditService } from "../metering/CreditService";
import { normalizePhone } from "./phoneNormalization";
import {
  TextJakeCustomerProfile,
  TextJakeCustomerRow,
  TextJakeCustomerStore,
} from "./TextJakeCustomerStore";
import { TextJakeCustomer } from "./TextJakeCustomerTypes";

// Re-export so existing importers (AdminTextCustomerService) keep their import
// path; the canonical E.164 implementation now lives in one leaf module
// (phoneNormalization) that the store can also import without a circular dep.
export { normalizePhone };

/**
 * The text-Jake customer service (JAK-115) — resolves the tier-1 billing identity.
 *
 * Text-Jake bills the texting CUSTOMER, resolved by their SENDER phone number
 * (both text modes). This service owns "who is this texter and what account do
 * they pay from": it normalizes the phone, upserts the customer row, and exposes
 * a stable {@link TextJakeCustomer.creditAccountId} the JAK-109 ledger charges
 * against — so a given phone always maps to the same customer and balance, and
 * two different phones never share an account (billing isolation).
 */
@injectable()
export class TextJakeCustomerService {
  constructor(
    private readonly store: TextJakeCustomerStore,
    private readonly credits: CreditService
  ) {}

  /**
   * Resolve (creating on first contact) the customer for a sender phone. Pass the
   * GHL contact id when known so status notes can target it; it's only set if we
   * don't already have one.
   *
   * On a genuinely NEW customer, seed their three per-feature credit balances
   * (JAK-161: report / skiptrace / comps) from the admin-editable defaults. The
   * seed is idempotent and only fired on first insert, so a returning texter
   * never pays the extra queries and is never re-granted.
   */
  async resolveByPhone(
    phone: string,
    ghlContactId?: string | null
  ): Promise<TextJakeCustomer> {
    return (await this.resolveByPhoneWithCreation(phone, ghlContactId)).customer;
  }

  /**
   * Like {@link resolveByPhone}, but also reports whether THIS call created the
   * customer (their first-ever contact). The assistant uses `created` to send the
   * one-time welcome + default-credit announcement (JAK-first-text-welcome) without
   * a second round-trip — the flag comes straight from the atomic upsert, so a
   * returning texter is never mistaken for a new one.
   */
  async resolveByPhoneWithCreation(
    phone: string,
    ghlContactId?: string | null
  ): Promise<{ customer: TextJakeCustomer; created: boolean }> {
    const normalized = normalizePhone(phone);
    const { row, created } = await this.store.upsertByPhone(normalized, ghlContactId ?? null);
    if (created) {
      await this.credits.seedNewCustomer(row.id);
    }
    return { customer: toCustomer(row), created };
  }

  /**
   * Record that Jake delivered one property report to this customer and return the
   * new running total (JAK-first-text-welcome). Drives the delayed onboarding ask.
   */
  async incrementReportCount(id: string): Promise<number | null> {
    return this.store.incrementReportCount(id);
  }

  /**
   * Mark the after-3rd-report onboarding email ask as sent, ONCE
   * (JAK-first-text-welcome). Returns true only for the call that actually set it,
   * so the caller sends the ask exactly once.
   */
  async markOnboardingAsked(id: string): Promise<boolean> {
    return this.store.markOnboardingAsked(id);
  }

  /**
   * Capture profile fields a texter provided in a follow-up reply
   * (JAK-first-text-welcome). Only non-null fields overwrite; the rest are left
   * untouched. Returns the updated customer, or null if the id is unknown.
   */
  async captureProfile(
    id: string,
    profile: Partial<TextJakeCustomerProfile>
  ): Promise<TextJakeCustomer | null> {
    const row = await this.store.captureProfile(id, profile);
    return row ? toCustomer(row) : null;
  }
}

function toCustomer(row: TextJakeCustomerRow): TextJakeCustomer {
  return {
    id: row.id,
    phone: row.phone,
    ghlContactId: row.ghl_contact_id,
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.email,
    // Two-level hold state (JAK-148). The DB default is 'active', so a row from
    // before this ticket (no column) still resolves to active.
    status: row.status ?? "active",
    // Report counter + onboarding-ask stamp (JAK-first-text-welcome). Column
    // defaults (0 / null) cover any row created before this ticket.
    reportCount: row.report_count ?? 0,
    onboardingAskedAt: row.onboarding_asked_at ?? null,
    // The credit account key IS the customer id — stable per customer.
    creditAccountId: row.id,
    createdAt: row.created_at,
    modifiedAt: row.modified_at,
  };
}
