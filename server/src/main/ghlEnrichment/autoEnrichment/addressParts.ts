/**
 * Structured address assembly for the auto-enrichment REAPI lookup (JAK-193).
 *
 * The GHL contact-created payload delivers address FIELDS (line1/city/state/postal),
 * sometimes dirty: a label glued onto the zip ("z:85335"), or a missing/lowercase
 * state. The old worker flattened these into one string and let the DAO re-parse it
 * with brittle regex — which REJECTED both cases before REAPI was ever called.
 *
 * These pure helpers build a clean STRUCTURED `{house, street, city, state, zip}`
 * that goes straight to REAPI (no re-parse), so:
 *   - the zip is ALWAYS reduced to a bare `\d{5}(?:-\d{4})?`, discarding any
 *     surrounding label/junk ("z:85335" / "zip:85335" / " 85335 " → "85335") — a
 *     HARD requirement since GHL emits the `z:` artifact intermittently;
 *   - a missing/odd state is normalized, and when absent DERIVED from the zip so
 *     REAPI receives a populated state instead of a parse failure.
 *
 * The SMS/text-Jake path (RealEstateApiDao.parseAddress / getPropertyDetailByAddress)
 * is intentionally left untouched.
 */

/** The clean structured address REAPI PropertyDetail is queried with. */
export interface EnrichmentAddressParts {
  house: string;
  street: string;
  /** May be "" when GHL omitted it (REAPI can key on street+zip). */
  city: string;
  /** 2-letter code; "" when neither the payload nor the zip yields one. */
  state: string;
  zip: string;
}

/** Loose GHL address fields, as the worker reads them off the payload. */
export interface RawAddressFields {
  line1?: string;
  city?: string;
  state?: string;
  postal?: string;
}

/**
 * Extract the BARE zip from a dirty postal value — always `\d{5}(?:-\d{4})?`, with
 * any surrounding label/junk discarded (JAK-193 hard requirement):
 *   "z:85335" → "85335", "zip:85335" → "85335", " 85335 " → "85335",
 *   "85335-1234" → "85335-1234". No 5-digit run → undefined.
 */
export function sanitizeZip(postal: string | undefined | null): string | undefined {
  if (typeof postal !== "string") return undefined;
  const m = postal.match(/\d{5}(?:-\d{4})?/);
  return m ? m[0] : undefined;
}

/** All USPS 2-letter state/territory codes we accept. */
const STATE_CODES = new Set([
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID", "IL", "IN",
  "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV",
  "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN",
  "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY", "DC", "PR",
]);

/** Full state name → code (mirrors the DAO's SMS-path map; independent by design). */
const STATE_NAME_TO_CODE: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA",
  colorado: "CO", connecticut: "CT", delaware: "DE", florida: "FL", georgia: "GA",
  hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA", kansas: "KS",
  kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD", massachusetts: "MA",
  michigan: "MI", minnesota: "MN", mississippi: "MS", missouri: "MO", montana: "MT",
  nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ",
  "new mexico": "NM", "new york": "NY", "north carolina": "NC", "north dakota": "ND",
  ohio: "OH", oklahoma: "OK", oregon: "OR", pennsylvania: "PA", "rhode island": "RI",
  "south carolina": "SC", "south dakota": "SD", tennessee: "TN", texas: "TX",
  utah: "UT", vermont: "VT", virginia: "VA", washington: "WA", "west virginia": "WV",
  wisconsin: "WI", wyoming: "WY", "district of columbia": "DC", "puerto rico": "PR",
};

/** Normalize a state value to a 2-letter code (2-letter or full name), or undefined. */
export function normalizeStateCode(state: string | undefined | null): string | undefined {
  if (typeof state !== "string") return undefined;
  const s = state.trim().replace(/\./g, "");
  if (/^[A-Za-z]{2}$/.test(s)) {
    const up = s.toUpperCase();
    return STATE_CODES.has(up) ? up : undefined;
  }
  return STATE_NAME_TO_CODE[s.toLowerCase()];
}

/**
 * Contiguous USPS ZIP3 (leading-3-digit) → state ranges. Best-effort fallback for a
 * missing state; unmapped prefixes (mostly military APO/FPO + a few gaps) → undefined,
 * in which case the caller omits the state and lets REAPI decide on street+city+zip.
 */
const ZIP3_RANGES: ReadonlyArray<readonly [number, number, string]> = [
  [6, 9, "PR"], [10, 27, "MA"], [28, 29, "RI"], [30, 38, "NH"], [39, 49, "ME"],
  [50, 59, "VT"], [60, 69, "CT"], [70, 89, "NJ"], [100, 149, "NY"], [150, 196, "PA"],
  [197, 199, "DE"], [200, 205, "DC"], [206, 219, "MD"], [220, 246, "VA"],
  [247, 268, "WV"], [270, 289, "NC"], [290, 299, "SC"], [300, 319, "GA"],
  [320, 349, "FL"], [350, 369, "AL"], [370, 385, "TN"], [386, 397, "MS"],
  [398, 399, "GA"], [400, 427, "KY"], [430, 459, "OH"], [460, 479, "IN"],
  [480, 499, "MI"], [500, 528, "IA"], [530, 549, "WI"], [550, 567, "MN"],
  [570, 577, "SD"], [580, 588, "ND"], [590, 599, "MT"], [600, 629, "IL"],
  [630, 658, "MO"], [660, 679, "KS"], [680, 693, "NE"], [700, 714, "LA"],
  [716, 729, "AR"], [730, 749, "OK"], [750, 799, "TX"], [800, 816, "CO"],
  [820, 831, "WY"], [832, 838, "ID"], [840, 847, "UT"], [850, 865, "AZ"],
  [870, 884, "NM"], [889, 898, "NV"], [900, 961, "CA"], [967, 968, "HI"],
  [970, 979, "OR"], [980, 994, "WA"], [995, 999, "AK"],
];

/** Derive a 2-letter state from a zip via its ZIP3 prefix, or undefined if unmapped. */
export function stateFromZip(zip: string | undefined | null): string | undefined {
  const clean = sanitizeZip(zip ?? undefined);
  if (!clean) return undefined;
  const prefix = Number(clean.slice(0, 3));
  if (!Number.isFinite(prefix)) return undefined;
  for (const [lo, hi, state] of ZIP3_RANGES) {
    if (prefix >= lo && prefix <= hi) return state;
  }
  return undefined;
}

/** Split "14001 N 127th Ln" → { house, street }; undefined without a leading number. */
export function splitStreet(
  line1: string | undefined | null
): { house: string; street: string } | undefined {
  if (typeof line1 !== "string") return undefined;
  const m = line1.trim().match(/^(\d+)\s+(.+?)\s*$/);
  return m ? { house: m[1], street: m[2].trim() } : undefined;
}

/** A trimmed non-empty string, or undefined. */
const str = (v: string | undefined | null): string | undefined => {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
};

/** Escape a string for literal use inside a RegExp. */
const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Build clean structured parts from GHL address FIELDS, or null when there's not
 * enough to key a lookup (no street number, or no zip). The zip is always bared;
 * the state is normalized, or DERIVED from the zip when absent, else "".
 */
export function partsFromFields(fields: RawAddressFields): EnrichmentAddressParts | null {
  const street = splitStreet(fields.line1);
  const zip = sanitizeZip(fields.postal);
  if (!street || !zip) return null;
  const state = normalizeStateCode(fields.state) ?? stateFromZip(zip) ?? "";
  return { house: street.house, street: street.street, city: str(fields.city) ?? "", state, zip };
}

/**
 * Parse a locality TAIL ("collierville, TN, 38017" / "El Mirage AZ z:85335" /
 * "atoka 38004") into its {city, state, zip} pieces: commas are flattened to
 * spaces, the bare zip is isolated (JAK-193), and an optional trailing state token
 * is normalized. Any piece may be undefined. Shared engine behind both the
 * combined-string fallback and the dirty-line1 street extraction (JAK-196).
 */
export function parseLocalityTail(
  tail: string | undefined | null
): { city?: string; state?: string; zip?: string } {
  if (typeof tail !== "string") return {};
  const flat = tail.replace(/,/g, " ").replace(/\s+/g, " ").trim();
  if (!flat) return {};
  const zip = sanitizeZip(flat);
  // Strip the zip (and any label glued to it) off the tail to isolate city [+ state].
  const beforeZip = zip ? flat.replace(/\S*\d{5}(?:-\d{4})?\S*\s*$/, "").trim() : flat;
  const tokens = beforeZip.split(/\s+/).filter(Boolean);
  let state: string | undefined;
  let city = beforeZip;
  if (tokens.length > 0) {
    const maybe = normalizeStateCode(tokens[tokens.length - 1]);
    if (maybe) {
      state = maybe;
      city = tokens.slice(0, -1).join(" ");
    }
  }
  return { city: str(city), state, zip };
}

/**
 * Fallback for a rawContact carrying a single combined address STRING
 * ("3165 Tracy Rd, atoka, 38004"). The street is everything before the FIRST
 * comma; the remainder is parsed as a locality tail, then reused through
 * {@link partsFromFields} so the same sanitize + state-derivation applies. Null
 * when there's no comma or it doesn't parse to a usable address.
 */
export function parseAddressLine(line: string | undefined | null): EnrichmentAddressParts | null {
  if (typeof line !== "string") return null;
  const comma = line.indexOf(",");
  if (comma < 0) return null;
  const line1 = line.slice(0, comma).trim();
  const loc = parseLocalityTail(line.slice(comma + 1));
  if (!loc.zip) return null;
  return partsFromFields({ line1, city: loc.city, state: loc.state, postal: loc.zip });
}

/**
 * Peel a trailing city/state/zip run off a NO-COMMA line1 using the KNOWN
 * structured values as anchors: strip the zip, then the state (raw or normalized),
 * then the city — each only when it sits at the very end. Returns the recovered
 * street, or the input unchanged when nothing matches (a normal "742 Evergreen
 * Terrace" is untouched).
 */
function stripKnownTail(
  line1: string,
  known: { city?: string; state?: string; zip?: string }
): string {
  let s = line1.trim();
  const peel = (token: string | undefined): void => {
    if (!token) return;
    const re = new RegExp(`[\\s,]+${escapeRegExp(token)}\\s*$`, "i");
    if (re.test(s)) s = s.replace(re, "").trim();
  };
  peel(known.zip);
  peel(known.state);
  peel(known.state ? normalizeStateCode(known.state) : undefined);
  peel(known.city);
  const cleaned = s.replace(/[\s,]+$/, "").trim();
  return cleaned.length > 0 ? cleaned : line1.trim();
}

/**
 * De-pollute a dirty line1 that carries the WHOLE address (JAK-196). GHL stores
 * some contacts' entire address in the street field —
 * "828 Pearson Oaks Dr, collierville, TN, 38017" — sometimes WITH the structured
 * city/state/zip ALSO filled. Passed straight to REAPI as `street`, that value
 * never matches. Recover the CLEAN street and merge locality:
 *
 *   1. COMMA — the street is everything before the first comma; the tail carries
 *      the embedded city/state/zip.
 *   2. KNOWN-FIELDS strip — no commas but structured city/state/zip are present:
 *      peel a trailing run matching them off line1 ("…Dr collierville TN 38017").
 *
 * Structured fields are AUTHORITATIVE: when present they win over anything parsed
 * out of line1. A no-comma blob with NO structured locality to anchor on is left
 * untouched ({@link partsFromFields} then fails → the worker's LLM parser handles
 * it). A plain street with no embedded locality is returned unchanged (no
 * regression for normal payloads).
 */
function mergeDirtyLine1(fields: RawAddressFields): RawAddressFields {
  const line1 = str(fields.line1);
  if (!line1) return fields;

  const sCity = str(fields.city);
  const sState = str(fields.state);
  const sZip = sanitizeZip(fields.postal);

  // 1. COMMA — split off the clean street; parse the tail for embedded locality.
  const comma = line1.indexOf(",");
  if (comma >= 0) {
    const loc = parseLocalityTail(line1.slice(comma + 1));
    return {
      line1: line1.slice(0, comma).trim(),
      city: sCity ?? loc.city,
      state: sState ?? loc.state,
      postal: str(fields.postal) ?? loc.zip,
    };
  }

  // 2. KNOWN-FIELDS strip — no commas, but we know the locality: peel it off.
  if (sCity || sState || sZip) {
    return { ...fields, line1: stripKnownTail(line1, { city: sCity, state: sState, zip: sZip }) };
  }

  // Plain street, or an unanchored no-comma blob — leave it for partsFromFields /
  // the LLM parser. Unchanged, so normal payloads never regress.
  return fields;
}

/**
 * Resolve clean structured parts from GHL fields. First de-pollutes a dirty line1
 * that carries the whole address ({@link mergeDirtyLine1} — comma-split or
 * known-field strip, structured fields authoritative), then builds via
 * {@link partsFromFields} (JAK-193 bare-zip + state-from-zip). Null when nothing
 * address-like resolves — the worker then falls back to the LLM parser.
 */
export function buildAddressParts(fields: RawAddressFields): EnrichmentAddressParts | null {
  return partsFromFields(mergeDirtyLine1(fields));
}

/** Human-readable one-line rendering of the parts, for logs. */
export function displayAddress(parts: EnrichmentAddressParts): string {
  const tail = [parts.state, parts.zip].filter(Boolean).join(" ");
  return [`${parts.house} ${parts.street}`, parts.city, tail]
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .join(", ");
}
