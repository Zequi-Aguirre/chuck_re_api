// JAK-136 — Skip-trace specialist types: the clean, verified shape the writer
// consumes, plus the cache/pending persistence rows.

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
  /** The owner / person the trace resolved, when the provider returned a name. */
  ownerName?: string;
  /** Contact phone numbers, most-relevant first, de-duplicated. */
  phones?: string[];
  /** Contact emails, de-duplicated. */
  emails?: string[];
  /** The owner's mailing address as a single display line, when present. */
  mailingAddress?: string;
}

/** True when a trace produced at least one piece of contact info worth billing for. */
export function hasContactInfo(data: SkipTraceData): boolean {
  return Boolean(
    (data.phones && data.phones.length) ||
      (data.emails && data.emails.length) ||
      data.ownerName ||
      data.mailingAddress
  );
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
 * Canonical cache key for a skip-trace target: lower-cased and
 * whitespace-collapsed, so casing/spacing variants of the same address hit the
 * same cache row. Mirrors JAK-134's addressCacheKey.
 */
export function skipTraceTargetKey(target: string): string {
  return String(target).trim().toLowerCase().replace(/\s+/g, " ");
}
