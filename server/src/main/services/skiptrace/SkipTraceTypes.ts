// JAK-136 — Skip-trace specialist types: the clean, verified shape the writer
// consumes, plus the cache/pending persistence rows.

/**
 * ONE matched person's verified contact info, grouped under THEIR name (JAK-145).
 * A skip trace can return several people for an address; the writer lists each
 * person's own phones/emails/mailing under their name instead of merging every
 * number into one flat list. Only present values are set — never fabricated.
 */
export interface SkipTracePersonContact {
  /** The person's name, when the provider returned one. */
  name?: string;
  /** This person's phone numbers, de-duplicated. */
  phones?: string[];
  /** This person's emails, de-duplicated. */
  emails?: string[];
  /** This person's mailing address as a single display line, when present. */
  mailingAddress?: string;
}

/**
 * The VERIFIED, SMS-ready subset the skip-trace specialist writes from. The
 * assistant assembles this from the raw /v2/SkipTrace record (only present
 * values are set — missing stays undefined, never null/blank), so the writer and
 * its deterministic fallback both work off ground truth and never invent contact
 * info. Mirrors how PropertyReportData fronts the property report writer.
 */
export interface SkipTraceData {
  /** The property address the trace was run for (for the reply header). */
  targetAddress?: string;
  /**
   * Who we ASKED the provider to trace (JAK-145) — the property owner, or the
   * person(s) the texter named. Shown so the reply is honest about the subject of
   * the trace even when the provider returns different address-linked people.
   */
  requestedName?: string;
  /** The owner / person the trace resolved, when the provider returned a name. */
  ownerName?: string;
  /**
   * The matched people, each with THEIR own contact info grouped under them
   * (JAK-145). The writer renders per-person blocks from this; the flat
   * phones/emails below stay as an aggregate for back-compat + the billing gate.
   */
  persons?: SkipTracePersonContact[];
  /** Contact phone numbers across all matched people, most-relevant first, de-duplicated. */
  phones?: string[];
  /** Contact emails across all matched people, de-duplicated. */
  emails?: string[];
  /** The primary person's mailing address as a single display line, when present. */
  mailingAddress?: string;
}

/** True when a trace produced at least one piece of contact info worth billing for. */
export function hasContactInfo(data: SkipTraceData): boolean {
  return Boolean(
    (data.phones && data.phones.length) ||
      (data.emails && data.emails.length) ||
      (data.persons && data.persons.length) ||
      data.ownerName ||
      data.mailingAddress
  );
}

/**
 * The resolved SUBJECT of a skip trace (JAK-145): WHO we trace, decoupled from the
 * property address. Either the property owner (pulled from PropertySearch
 * ownerInfo) or the specific person(s) the texter named ("skip trace Jane and
 * John"). `names` drives the display + the per-person cache identity; the
 * primary `firstName`/`lastName` are what we pass to the /v2/SkipTrace endpoint.
 */
export interface SkipTraceSubject {
  /** The names identifying the trace subject (owner name, or the texter-named people). */
  names: string[];
  /** The primary person's first name passed to the provider, when known. */
  firstName?: string | null;
  /** The primary person's last name passed to the provider, when known. */
  lastName?: string | null;
  /**
   * The address to actually query /v2/SkipTrace with (JAK-145), when it differs
   * from the property address. /v2/SkipTrace is ADDRESS-DOMINANT — it returns the
   * current residents of whatever address we pass, ignoring the owner name — so for
   * an ABSENTEE property the property address returns tenants, never the owner. When
   * set (the owner's tax MAILING address for an absentee owner), the trace runs on
   * this address instead; the property address stays the report header + cache key.
   * Unset for owner-occupants, where the property address is traced as before.
   */
  traceAddress?: string | null;
}

/**
 * Raw persistence row for `text_jake_skip_traces` (JAK-136) — a snapshot of one
 * PAID skip-trace result, the backing store for the free re-serve rule (a repeat
 * trace of the same target within the free window is served free from here). The
 * SAME shape as the JAK-134 lookup cache, keyed per (phone, target).
 */
export interface SkipTraceRow {
  id: string;
  customer_id: string;
  phone: string;
  message_id: string | null;
  normalized_target: string;
  /** Canonical cache key (lower-cased, whitespace-collapsed). */
  target_key: string;
  /** The FULL verified /v2/SkipTrace record (whole record kept for later needs). */
  trace_record: unknown;
  /** The exact SMS we sent, so a free re-serve returns the identical reply. */
  report_text: string;
  fetched_at: Date;
  created_at: Date;
}

/**
 * Raw persistence row for `text_jake_skip_trace_pending` (JAK-136) — the ONE
 * outstanding "reply OK to run it" skip-trace offer per phone (upserted). Because
 * skip-trace costs more than a report, we NEVER spend on the first ask: we quote
 * the price, store this row, and consume it when the texter confirms with OK/YES.
 */
export interface SkipTracePendingRow {
  phone: string;
  customer_id: string;
  /** The address the pending trace will run on. */
  target: string;
  /** The credits it will cost (captured at offer time so the price can't drift). */
  credits: number;
  created_at: Date;
}

/**
 * The canonical PERSON-identity half of a skip-trace cache key (JAK-145): the
 * trace subject's names, each lower-cased + whitespace-collapsed, then SORTED and
 * joined so name order doesn't matter ("Jane and John" == "John and
 * Jane"). Empty string when the subject is unknown (owner name unresolved),
 * which collapses the key back to address-only. This is what makes a request for a
 * DIFFERENT person at the SAME address a NEW lookup rather than a cached hit.
 */
export function skipTraceSubjectKey(names: readonly string[]): string {
  return names
    .map((n) => String(n).trim().toLowerCase().replace(/\s+/g, " "))
    .filter(Boolean)
    .sort()
    .join("|");
}

/**
 * Canonical cache key for a skip-trace target (JAK-145): the address (lower-cased,
 * whitespace-collapsed) PLUS the resolved-person identity, so the cache/free-reserve
 * is keyed on (address + person), not address alone. A repeat trace of the SAME
 * person at an address hits the same row (free re-serve); a trace of a DIFFERENT
 * person at that address is a distinct row (a new lookup). When no subject is known
 * the key is address-only, matching JAK-134/136 legacy behavior.
 */
export function skipTraceTargetKey(target: string, subjectKey = ""): string {
  const address = String(target).trim().toLowerCase().replace(/\s+/g, " ");
  return subjectKey ? `${address}::${subjectKey}` : address;
}
