/**
 * Inbound contract for the auto-enrichment "contact created" webhook (JAK-182,
 * epic JAK-180).
 *
 * A GHL WORKFLOW (automation) POSTs here when a new contact is created in an
 * installed sub-account (Zequi configures the GHL side; we own the receiver). The
 * receiver's job is narrow: authenticate, normalize GHL's flexible field names to
 * a clean shape, resolve the location, and ENQUEUE an enrichment job (JAK-181).
 * The REAPI lookup + write-back happen in the worker (JAK-183), never in-request.
 *
 * ── The payload contract Zequi configures GHL to send ────────────────────────
 * A JSON body. REQUIRED routing fields (the request is rejected 400 without them):
 *   - locationId   — the GHL sub-account id       (accepted: locationId | location_id)
 *   - contactId    — the created contact's id     (accepted: contactId | contact_id | id)
 * STRONGLY RECOMMENDED (the property to enrich; omitted → enqueued for best-effort
 * resolution in the worker, never rejected):
 *   - address line1 (accepted: address1 | address | line1 | street)
 *   - city          (accepted: city)
 *   - state         (accepted: state)
 *   - postal code   (accepted: postalCode | postal_code | postalcode | zip | zipCode)
 *
 * Everything is matched case-tolerantly at the value level; unknown extra fields
 * are ignored. See {@link ContactCreatedResource} for the normalization.
 */

/**
 * The subset of a raw GHL workflow POST body we read. GHL sends a richer payload;
 * we only touch routing + address fields and stay tolerant of the id/casing
 * variants GHL uses across workflow configurations. The index signature keeps the
 * shape forward-compatible and lets the raw body ride along to the worker.
 */
export interface RawContactCreatedBody {
  // Location (sub-account) id variants.
  locationId?: unknown;
  location_id?: unknown;

  // Contact id variants — GHL puts the created contact's id in `id` on some configs.
  contactId?: unknown;
  contact_id?: unknown;
  id?: unknown;

  // Address variants.
  address1?: unknown;
  address?: unknown;
  line1?: unknown;
  street?: unknown;
  city?: unknown;
  state?: unknown;
  postalCode?: unknown;
  postal_code?: unknown;
  postalcode?: unknown;
  zip?: unknown;
  zipCode?: unknown;

  [key: string]: unknown;
}

/**
 * A validated, routing-ready view of a contact-created webhook. Built only when
 * both ids are present; the address is normalized best-effort (undefined when the
 * payload carried none).
 */
export interface ParsedContactCreated {
  locationId: string;
  contactId: string;
  /** Normalized address parts present on the payload (each omitted when blank). */
  address?: {
    line1?: string;
    city?: string;
    state?: string;
    postal?: string;
  };
}
