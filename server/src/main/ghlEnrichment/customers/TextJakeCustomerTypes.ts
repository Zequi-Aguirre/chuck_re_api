/**
 * Types for the text-Jake customer record (JAK-115) — the tier-1 billing identity.
 *
 * A "customer" is the person who texted in, resolved by their SENDER phone number
 * (both text modes). It carries the credit account their prepaid balance is drawn
 * from. Distinct from a {@link import("../connections/GhlConnectionTypes").GhlConnection},
 * which is a customer's own GHL sub-account + per-tenant key.
 */

/** A resolved text-Jake customer as callers see it. */
export interface TextJakeCustomer {
  id: string;
  /** Sender phone number, E.164 — the stable key for this customer. */
  phone: string;
  /** Contact id in the GHL sub-account handling their texts; null until known. */
  ghlContactId: string | null;
  /** Optional profile (JAK-146) — nullable; phone stays the required identity. */
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  /**
   * The account key this customer's credits are billed against in the JAK-109
   * ledger. Stable per customer — equals {@link id} — so a texter always draws
   * from the same balance.
   */
  creditAccountId: string;
  createdAt: Date;
  modifiedAt: Date;
}
