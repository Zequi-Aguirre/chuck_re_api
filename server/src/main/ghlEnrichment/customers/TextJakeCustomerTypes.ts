/**
 * Types for the text-Jake customer record (JAK-115) — the tier-1 billing identity.
 *
 * A "customer" is the person who texted in, resolved by their SENDER phone number
 * (both text modes). It carries the credit account their prepaid balance is drawn
 * from. Distinct from a {@link import("../connections/GhlConnectionTypes").GhlConnection},
 * which is a customer's own GHL sub-account + per-tenant key.
 */

/**
 * The hold state of a text-Jake customer (JAK-148) — a two-level hold that never
 * touches their credit balance:
 *  - `active`      — normal: GHL forwards their texts and Jake processes + charges.
 *  - `on_hold`     — SOFT hold: GHL still forwards (the "text Jake" approval field
 *                    stays set), but Jake intercepts inbound server-side, replies a
 *                    friendly hold notice, and does NOT run a specialist or charge.
 *  - `deactivated` — HARD off: the "text Jake" field is flipped to unapproved via
 *                    the JAK-147 sync so GHL stops forwarding; a backstop still
 *                    refuses to process/charge if an inbound slips through anyway.
 */
export type TextCustomerStatus = "active" | "on_hold" | "deactivated";

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
  /** Two-level hold state (JAK-148). Defaults to `active`; never affects credits. */
  status: TextCustomerStatus;
  /**
   * How many property reports Jake has delivered to this customer
   * (JAK-first-text-welcome). Drives the DELAYED onboarding email ask, which fires
   * once right after the 3rd report. Defaults to 0.
   */
  reportCount: number;
  /**
   * When the after-3rd-report onboarding email ask was sent, or null if it hasn't
   * been (JAK-first-text-welcome). Doubles as the once-only guard and the flag
   * that enables follow-up name/email capture for this customer.
   */
  onboardingAskedAt: Date | null;
  /**
   * When this customer's credits are next restored to the effective default
   * (JAK-monthly-credit-restore), anchored to their signup day-of-month. Surfaced
   * so a READ-ONLY status reply (JAK-credit-keyword) can tell the texter when their
   * balances reset. The DB column is NOT NULL, but kept nullable here so a row
   * predating the column (or an unset value) resolves gracefully to "unknown".
   */
  nextResetAt: Date | null;
  /**
   * The account key this customer's credits are billed against in the JAK-109
   * ledger. Stable per customer — equals {@link id} — so a texter always draws
   * from the same balance.
   */
  creditAccountId: string;
  createdAt: Date;
  modifiedAt: Date;
}
