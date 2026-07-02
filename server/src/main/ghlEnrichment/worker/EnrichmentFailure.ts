import { GhlApiError } from "../api/GhlApiClient";

/**
 * Failure handling primitives for the enrichment pipeline (JAK-111).
 *
 * This module is PURE (no I/O) and is the SINGLE place that decides:
 *   1. whether a failure is worth retrying ({@link classifyFailure}), and
 *   2. how an arbitrary error becomes a short, queryable, SECRET-FREE string
 *      ({@link summarizeError} + {@link redactSecrets}).
 *
 * Both the {@link import("./GhlEnrichmentWorker").GhlEnrichmentWorker} (deciding
 * whether to re-throw for a BullMQ retry) and the queue's dead-letter hook
 * (recording the terminal state) consume it, so the "should we retry?" verdict
 * can never drift between the two. It consolidates the minimal, duplicated
 * classification JAK-107 stubbed inline.
 */

/** Transient = retry with backoff; permanent = fail fast to the dead-letter state. */
export type FailureKind = "transient" | "permanent";

export interface ClassifiedFailure {
  kind: FailureKind;
  /** Short, secret-free summary safe to log and persist on the event row. */
  summary: string;
}

/** Max length of a persisted/logged error detail — keeps the events column tidy. */
const MAX_DETAIL_LENGTH = 500;

/**
 * Classify a thrown error for retry policy.
 *
 * Transient (worth retrying): a GHL rate-limit (429), server error (5xx), or a
 * network/timeout failure (no HTTP status). Also any non-API error (e.g. a
 * Postgres blip) — a transient infrastructure hiccup deserves another go.
 *
 * Permanent (fail fast, no retry): a specific GHL 4xx — a bad payload, malformed
 * request, or contact/location the API rejects outright. Retrying can't fix it.
 */
export function classifyFailure(err: unknown): ClassifiedFailure {
  const summary = summarizeError(err);
  if (err instanceof GhlApiError) {
    const status = err.status;
    const transient = status === undefined || status === 429 || (status >= 500 && status <= 599);
    return { kind: transient ? "transient" : "permanent", summary };
  }
  // Unknown / non-API error (DB, serialization, …): treat as transient so an
  // infrastructure blip gets another attempt rather than dead-lettering a record.
  return { kind: "transient", summary };
}

/**
 * A short, SECRET-FREE description of an error, safe for logs and the event
 * `detail` column. Never includes the Bearer token or decrypted credentials —
 * GHL API errors are summarized to `GHL <status>`, and everything is passed
 * through {@link redactSecrets} + truncated as defense-in-depth.
 */
export function summarizeError(err: unknown): string {
  let raw: string;
  if (err instanceof GhlApiError) {
    raw = err.status ? `GHL ${err.status}` : err.message;
  } else if (err instanceof Error) {
    raw = err.message;
  } else {
    raw = "unknown error";
  }
  return redactSecrets(raw).slice(0, MAX_DETAIL_LENGTH);
}

/**
 * Strip anything credential-shaped from a string before it is logged or stored.
 * Belt-and-suspenders: the worker never puts a token in an error string, but a
 * wrapped library error might, so we redact `Bearer <token>` and common
 * `key/token/secret/authorization = <value>` shapes at the boundary.
 */
export function redactSecrets(text: string): string {
  return text
    // `Bearer <token>` (covers Authorization headers) → redact the token.
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer ***")
    // `apiKey=... / token: ... / secret=...` assignment shapes. "authorization"
    // is intentionally NOT listed — the Bearer rule above already covers it, and
    // listing it here would clobber the "Bearer ***" the first rule produced.
    .replace(
      /\b(api[_-]?key|token|secret|password)(["']?\s*[:=]\s*["']?)[^\s"',}]+/gi,
      "$1$2***"
    );
}

/** Structured, queryable log fields for one enrichment event. Never a credential. */
export interface EnrichmentLogFields {
  /** Machine-readable event name, e.g. "enrichment_failed_transient". */
  event: string;
  locationId: string;
  contactId: string;
  /** Event status where relevant (enriched | failed | dead_letter | …). */
  status?: string;
  /** 1-based processing attempt, when known. */
  attempt?: number;
  /** Human detail — passed through {@link redactSecrets} before emission. */
  detail?: string;
}

/**
 * Emit one structured, secret-free log line for an enrichment event. JSON so it
 * is queryable in a log aggregator (filter by `event`, `status`, `location_id`,
 * `contact_id`). The `detail` is redacted here too, so no call site can leak a
 * token through logging.
 */
export function logEnrichment(
  level: "info" | "warn" | "error",
  fields: EnrichmentLogFields
): void {
  const line = JSON.stringify({
    ticket: "jak-111",
    level,
    event: fields.event,
    location_id: fields.locationId,
    contact_id: fields.contactId,
    ...(fields.status !== undefined ? { status: fields.status } : {}),
    ...(fields.attempt !== undefined ? { attempt: fields.attempt } : {}),
    ...(fields.detail !== undefined ? { detail: redactSecrets(fields.detail) } : {}),
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}
