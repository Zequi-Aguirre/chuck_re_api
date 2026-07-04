// Inbound address formatting + validation for the SMS assistant.
// Mirrors the Automator address-check approach: clean up free-form SMS text and
// confirm it looks like a real street address before spending a RealEstate API
// call on it. The RealEstate API does the authoritative parsing downstream.

const ZIP_RE = /\b\d{5}(?:-\d{4})?\b/;
const HOUSE_NUMBER_RE = /^\s*\d+\s+\S/;

/**
 * Normalize a raw inbound message into a single-line address string suitable
 * for /v2/PropertySearch, or return null if it doesn't look like an address.
 *
 * Accepted when the text starts with a house number AND contains either a
 * 5-digit ZIP or a comma (city/state separator) — enough to reject obvious
 * non-addresses ("hi", "what's up") without over-rejecting partial addresses.
 */
export function normalizeInboundAddress(raw: string | null | undefined): string | null {
    if (!raw) return null;

    const cleaned = String(raw).replace(/\s+/g, " ").trim();
    if (!cleaned) return null;

    const hasHouseNumber = HOUSE_NUMBER_RE.test(cleaned);
    const looksAddressy = ZIP_RE.test(cleaned) || cleaned.includes(",");

    if (!hasHouseNumber || !looksAddressy) return null;

    return cleaned;
}

/**
 * A leading command word/phrase the texter may prefix an address with (JAK-156):
 * "skip", "skip trace" / "skiptrace", "comp" / "comps", "cma", "run", "pull". We
 * strip exactly ONE such prefix (plus any trailing separators like ":", "-", ",")
 * before re-parsing the remainder as an address. Case-insensitive; anchored at the
 * start only. Addresses begin with a house NUMBER, so no real street can match this
 * alpha prefix — the strip is safe.
 */
const COMMAND_PREFIX_RE = /^(?:skip(?:\s*trace)?|comps?|cma|run|pull)\b[\s:,-]*/i;

/**
 * Parse an address that may be typed INSIDE a command (JAK-156): "skip 123 Main St,
 * Tampa FL", "comps 123 Main St, 90210", "cma 123 Main St, ...". Strips one leading
 * command word/phrase (see {@link COMMAND_PREFIX_RE}) and runs
 * {@link normalizeInboundAddress} on the remainder.
 *
 * A bare address with NO command word is unaffected — the strip is a no-op and it
 * parses exactly as {@link normalizeInboundAddress} would, so the report path is
 * preserved. Because normalizeInboundAddress still requires the remainder to START
 * with a house number, this only fires on a genuine "{command} {address}" shape:
 * "skip", "skip trace the owner", "comps for it", "run the numbers" all yield null.
 */
export function parseCommandAddress(raw: string | null | undefined): string | null {
    if (!raw) return null;

    const cleaned = String(raw).replace(/\s+/g, " ").trim();
    if (!cleaned) return null;

    const stripped = cleaned.replace(COMMAND_PREFIX_RE, "");
    return normalizeInboundAddress(stripped);
}
