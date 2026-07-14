/**
 * Pure text helper for the READ-ONLY credit-status reply (JAK-credit-keyword):
 * when a customer texts 'credit'/'credits', Jake reports their three per-bucket
 * balances and when they next reset. No I/O, no DI — just data in / string out —
 * so the wording, the no-emoji rule, and the date formatting are exhaustively
 * unit-testable.
 *
 * The GoTextJake.com footer is NOT added here: like the welcome + out-of-credits
 * copy, the SENDER appends the canonical footer at send time, so it can never be
 * edited or built away. The string is deliberately emoji-free and TTS-friendly.
 */

/** A customer's three balances plus their next reset date (null when unknown). */
export interface CreditBalanceView {
  report: number;
  skiptrace: number;
  comps: number;
  /** When the balances next restore; null/unknown → the reset line is omitted. */
  nextResetAt: Date | null;
}

/** "50 report credits" / "1 report credit" — pluralized for clean TTS. */
function creditPhrase(n: number, label: string): string {
  return `${n} ${label} credit${n === 1 ? "" : "s"}`;
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

/**
 * Human-friendly reset date, e.g. "August 7". Formatted from the date's UTC
 * components so it renders deterministically regardless of server timezone (the
 * reset lands on the signup day-of-month; the exact instant/tz is immaterial to
 * the texter). The year is omitted — the reset is always the near-future
 * anniversary, so month + day reads cleanly over SMS and TTS.
 */
export function formatResetDate(date: Date): string {
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`;
}

/**
 * The credit-status reply (JAK-credit-keyword): all three current balances and,
 * when known, the next reset date. Emoji-free, TTS-friendly; the sender appends
 * the footer. When {@link CreditBalanceView.nextResetAt} is null the reset
 * sentence is dropped gracefully.
 *
 * Example: "You have 50 report credits, 10 skip trace credits, and 10 comps
 * credits. They reset on August 7."
 */
export function buildCreditBalanceMessage(view: CreditBalanceView): string {
  const balances =
    `You have ${creditPhrase(view.report, "report")}, ` +
    `${creditPhrase(view.skiptrace, "skip trace")}, and ` +
    `${creditPhrase(view.comps, "comps")}.`;
  if (!view.nextResetAt) return balances;
  return `${balances} They reset on ${formatResetDate(view.nextResetAt)}.`;
}
