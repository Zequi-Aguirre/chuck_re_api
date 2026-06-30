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
