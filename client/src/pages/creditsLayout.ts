/**
 * Shared, DOM-free helpers for the per-feature credit buckets (JAK-161/JAK-162).
 *
 * A text-Jake customer has THREE independent balances — report / skiptrace /
 * comps — and the admin UI has to render all three consistently in three places:
 * the customer card/table, the grant dialog's type picker, and the credit
 * settings page. The bucket order, human labels, and the compact chip glyphs
 * live here (pure, no JSX/MUI) so they stay identical everywhere and the mapping
 * is unit-testable without a DOM.
 */

import type { CreditBalances, CreditType } from "../types";

/** The three buckets in a stable display order — mirrors the server's CREDIT_TYPES. */
export const CREDIT_TYPES: readonly CreditType[] = ["report", "skiptrace", "comps"];

/** Full, human label for a bucket — used in the picker + settings headings. */
export function creditTypeLabel(type: CreditType): string {
  switch (type) {
    case "skiptrace":
      return "Skip-trace";
    case "comps":
      return "Comps";
    case "report":
    default:
      return "Report";
  }
}

/** Short label for the compact per-bucket chips on the customer card/table. */
export function creditTypeShort(type: CreditType): string {
  switch (type) {
    case "skiptrace":
      return "Skip";
    case "comps":
      return "Comps";
    case "report":
    default:
      return "Report";
  }
}

/**
 * The `app_settings` default-grant key for a bucket — kept in lockstep with the
 * server's CreditSettingsService.defaultKey. Handy for tests + copy.
 */
export function defaultGrantKey(type: CreditType): string {
  return `default_${type}_credits`;
}

/** The `app_settings` out-of-credits-message key for a bucket (mirrors the server). */
export function outOfCreditsMessageKey(type: CreditType): string {
  return `out_of_credits_message_${type}`;
}

/**
 * A bucket's balance from a customer's per-feature balances, defaulting a missing
 * bucket to 0 — so a pre-split customer with only a report balance still renders
 * three chips (skip/comps show 0) rather than crashing.
 */
export function balanceOf(credits: CreditBalances | undefined, type: CreditType): number {
  return credits?.[type] ?? 0;
}
