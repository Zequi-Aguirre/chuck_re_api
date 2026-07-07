/**
 * JAK-dedup-customers — the ONE canonical phone normalizer for text-Jake customers.
 *
 * A texting customer is keyed by their sender phone (JAK-115). Two code paths used
 * to store that number in two different shapes: the gateway/billing path persisted
 * GHL's E.164 form ("+14845076216"), while the admin dashboard persisted whatever
 * an admin typed ("(484)507-6216"). Since the DB key is the literal string, the
 * SAME number split into TWO customer rows — one named, one an unnamed duplicate.
 *
 * This function collapses every accepted shape to a single canonical E.164 key
 * (`+1XXXXXXXXXX` for US/NANP numbers) so a number ALWAYS resolves to one row. It
 * is applied at every customer create + lookup (the store methods and the service
 * layer), and the matching SQL expression in the JAK-dedup-customers migration
 * mirrors it EXACTLY so historic rows canonicalize the same way this code does.
 *
 * It is idempotent — `normalizePhone(normalizePhone(x)) === normalizePhone(x)` —
 * so normalizing an already-canonical value is always a no-op.
 */
export function normalizePhone(phone: string): string {
  const raw = String(phone ?? "").trim();
  // Strip everything that isn't a digit: '+', spaces, parens, dashes, dots.
  const digits = raw.replace(/\D/g, "");

  // US/NANP 11-digit with the leading country code, or a bare 10-digit number —
  // the two shapes real inbound + admin-typed numbers take. Both fold to +1XXXXXXXXXX.
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;

  // Any other shape that still carries digits (e.g. a non-US E.164 number): keep
  // every digit behind ONE leading '+', so it collapses to a single stable key
  // without us guessing a country code. Still idempotent.
  if (digits.length > 0) return `+${digits}`;

  // No digits at all: fall back to whitespace-stripping only, matching the
  // pre-JAK behavior so a genuinely non-numeric value never changes meaning.
  return raw.replace(/\s+/g, "");
}
