// JAK-138 — Pure, deterministic parsers for the two follow-up reference shapes the
// disambiguation polish relies on:
//   1. a BARE numeric/ordinal SELECTION ("2", "the last one") that picks an address
//      out of a numbered list Jake just showed;
//   2. a PERSON reference ("the 3rd person", "that owner") into a prior skip-trace
//      result's entities.
// Kept out of the assistant so both are unit-testable without any I/O, mirroring
// how JAK-135 keeps reference resolution deterministic in code.

/** A resolved selection: a 1-based index, or "last" for "the last one". */
export type OrdinalSelection = number | "last";

/** Ordinal WORDS we accept as a selection or a person index (first..tenth). */
const ORDINAL_WORDS: Readonly<Record<string, number>> = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
  tenth: 10,
};

/** Filler words stripped before deciding whether a message is a BARE selection. */
const SELECTION_FILLER = /\b(the|one|please|address|addresses|property|number|no|thanks)\b/g;

/**
 * Parse a message that is ONLY an address selection — a bare number/ordinal after
 * Jake showed a numbered list ("2", "#2", "2nd", "the third", "the last one").
 * Returns the 1-based index or "last"; null when the message carries anything more
 * than a single selection token, so a real request is never mistaken for a pick.
 * Callers gate this on a fresh pending disambiguation existing.
 */
export function parseOrdinalSelection(message: string): OrdinalSelection | null {
  const raw = String(message).trim().toLowerCase();
  if (!raw) return null;
  const cleaned = raw
    .replace(/[#().!?,:*_-]/g, " ")
    .replace(SELECTION_FILLER, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return null;
  const tokens = cleaned.split(" ");
  if (tokens.length !== 1) return null;
  const token = tokens[0];
  if (token === "last") return "last";
  const word = ORDINAL_WORDS[token];
  if (word) return word;
  const m = token.match(/^(\d{1,3})(?:st|nd|rd|th)?$/);
  if (m) {
    const n = Number(m[1]);
    if (Number.isInteger(n) && n >= 1) return n;
  }
  return null;
}

/**
 * JAK-159 — a "last" reference to a PRIOR property EMBEDDED in a larger command
 * ("comp the last one", "skip the last property", "run the last address"), as
 * opposed to a bare selection {@link parseOrdinalSelection} handles. Matches the
 * phrase "last" followed by a property noun ("last one/property/address/home") or
 * a trailing "the last" ("comp the last"). Deliberately does NOT match numbered
 * ordinals ("the 2nd one") — those stay POSITIONAL — nor time words ("last week").
 *
 * Callers route a match through the genuinely MOST-RECENT address (the JAK-154
 * `lastResolvedAddress`, ORDER BY created_at DESC), NOT the END of the
 * first-appearance ordinal list, which can disagree after the texter re-sends an
 * older address. See {@link parseOrdinalSelection} for the bare-selection form.
 */
const LAST_ADDRESS_REFERENCE =
  /\blast\s+(?:one|property|properties|address(?:es)?|prop|home|house|place)\b|\bthe\s+last\b(?=[\s.!?,]*$)/;

export function mentionsLastAddressReference(message: string): boolean {
  return LAST_ADDRESS_REFERENCE.test(String(message).trim().toLowerCase());
}

/** A person reference into a prior skip-trace result. */
export interface PersonReference {
  /** True when the message explicitly picks a person ("that owner", "the 3rd person"). */
  matched: boolean;
  /** The 1-based person index when one was named ("3rd owner"), else null. */
  ordinal: number | null;
}

/** The person-noun alternation a reference must contain to count as a person pick. */
const PERSON_NOUN = "(?:owners?|persons?|people|sellers?|contacts?)";

/**
 * Parse an EXPLICIT person reference into a prior skip-trace result: an ordinal +
 * person noun ("the 3rd person", "2nd owner") or a demonstrative + person noun
 * ("that owner", "this person"). A plain "the owner" / "find the owner" does NOT
 * match — that's a normal skip-trace request, not a back-reference — so the
 * person path never hijacks a first-time trace.
 */
export function parsePersonReference(message: string): PersonReference {
  const raw = ` ${String(message).trim().toLowerCase()} `;
  const numMatch = raw.match(new RegExp(`(\\d{1,2})(?:st|nd|rd|th)?\\s+${PERSON_NOUN}\\b`));
  if (numMatch) return { matched: true, ordinal: Number(numMatch[1]) };
  for (const [word, val] of Object.entries(ORDINAL_WORDS)) {
    if (new RegExp(`\\b${word}\\s+${PERSON_NOUN}\\b`).test(raw)) return { matched: true, ordinal: val };
  }
  if (new RegExp(`\\b(?:that|this)\\s+${PERSON_NOUN}\\b`).test(raw)) return { matched: true, ordinal: null };
  return { matched: false, ordinal: null };
}
