/**
 * Pure footer-substitution helper for the sender (JAK-188).
 *
 * Every text-Jake reply is assembled ending in the canonical DEFAULT footer
 * (JAK-157/158) — the report writers enforce it and the non-report builders join
 * it on. Rather than thread an async footer pick through ~25 construction sites,
 * the single outbound funnel (`JakeAssistantService.sendAndRemember`) swaps that
 * trailing default footer for the per-message CHOSEN footer right before send.
 *
 * This keeps the substitution:
 *   - EXACT on spacing — only the footer TEXT is replaced; the blank-line spacing
 *     the reply already uses in front of the footer is untouched;
 *   - SAFE — a reply that does NOT end in the default footer (e.g. the short "on
 *     it" ack, which intentionally has none) is returned unchanged;
 *   - a NO-OP when the chosen footer IS the default (e.g. day-1 with only the
 *     seeded footer active), so byte-for-byte behavior is preserved.
 */

/**
 * Return `reply` with a trailing `defaultFooter` replaced by `chosenFooter`.
 * No-op when the chosen equals the default, or when the reply doesn't end with
 * the default footer.
 */
export function applyChosenFooter(
  reply: string,
  chosenFooter: string,
  defaultFooter: string
): string {
  if (chosenFooter === defaultFooter) return reply;
  if (!reply.endsWith(defaultFooter)) return reply;
  return reply.slice(0, reply.length - defaultFooter.length) + chosenFooter;
}

/**
 * Return `reply` with a trailing `defaultFooter` (and the blank-line separator in
 * front of it) removed — for the `footer: false` send path used by CREDIT / system
 * notices (out-of-credits, credit balance), which must go out with NO footer
 * (JAK-188 refinement). A no-op when the reply doesn't end with the default footer.
 */
export function stripTrailingFooter(reply: string, defaultFooter: string): string {
  if (!reply.endsWith(defaultFooter)) return reply;
  return reply.slice(0, reply.length - defaultFooter.length).replace(/\s+$/, "");
}
