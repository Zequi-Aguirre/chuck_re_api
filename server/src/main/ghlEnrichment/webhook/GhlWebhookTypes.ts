/**
 * Types for the inbound GHL webhook receiver (JAK-106).
 *
 * GHL fires a webhook when a contact is created in an installed sub-account. The
 * receiver's job is narrow: authenticate it, work out which location + contact it
 * concerns, and enqueue an enrichment job — never enrich inline (that's JAK-107).
 */

/**
 * The subset of a raw GHL webhook body we read. GHL sends a richer payload; we
 * only touch the routing fields and are tolerant of the couple of casings GHL
 * uses across event shapes (`id` vs `contactId`, `locationId` vs `location_id`).
 */
export interface RawGhlWebhookBody {
  /** Event type, e.g. "ContactCreate". Absent on some custom-webhook configs. */
  type?: string;
  /** GHL sub-account id. */
  locationId?: string;
  location_id?: string;
  /** Contact id — GHL puts the created contact's id in `id` on ContactCreate. */
  id?: string;
  contactId?: string;
  contact_id?: string;
  /** Best-effort address fields (present on ContactCreate); the worker re-loads canonically. */
  address1?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  postal_code?: string;
  [key: string]: unknown;
}

/** A validated, routing-ready view of a webhook we intend to act on. */
export interface ParsedContactWebhook {
  /** The event type as received (defaults to "ContactCreate" when GHL omits it). */
  type: string;
  locationId: string;
  contactId: string;
  /** Normalized single-line address if the payload carried one; else undefined. */
  fullAddress?: string;
}

/** The only event type the MVP acts on. ContactUpdate is flagged off (JAK-106 scope). */
export const SUPPORTED_EVENT_TYPE = "ContactCreate";
