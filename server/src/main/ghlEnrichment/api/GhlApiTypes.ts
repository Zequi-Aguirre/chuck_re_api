/**
 * Request/response shapes for the multi-tenant GHL API v2 client (JAK-104).
 *
 * Deliberately narrow — only the fields the enrichment MVP actually reads or
 * writes are modelled. GHL returns much more; we keep these thin so a payload
 * change upstream doesn't ripple through the app, and index-signature escape
 * hatches (`[key: string]: unknown`) let callers reach rarely-used fields
 * without us pretending to model the whole API.
 */

/** A GHL custom field VALUE as sent on a contact write. */
export interface GhlCustomFieldValue {
  /** The custom field key (e.g. `ownername`) or its id. */
  key?: string;
  id?: string;
  value: unknown;
}

/** A GHL contact as much of it as the enrichment flow needs. */
export interface GhlContact {
  id: string;
  locationId?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  address1?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  customFields?: Array<{ id: string; value: unknown }>;
  [key: string]: unknown;
}

/** A GHL custom field DEFINITION (from list/create custom fields). */
export interface GhlCustomField {
  id: string;
  name: string;
  /** GHL field key, e.g. `contact.ownername`. */
  fieldKey?: string;
  dataType?: string;
  [key: string]: unknown;
}

/** A GHL note as returned by the notes API. */
export interface GhlNote {
  id: string;
  body: string;
  contactId?: string;
  [key: string]: unknown;
}

/**
 * Result of sending an outbound SMS via the Conversations API (JAK-114 /
 * text-Jake). GHL returns ids we don't act on; kept open so callers can log
 * without us modelling the whole payload.
 */
export interface GhlSmsSendResult {
  conversationId?: string;
  messageId?: string;
  [key: string]: unknown;
}

/**
 * Input for provisioning a custom field on a location (JAK-105 uses this to
 * auto-create the canonical Jake fields on install).
 */
export interface CreateCustomFieldInput {
  /** Human-readable field name shown in the GHL UI. */
  name: string;
  /** GHL data type: TEXT, LARGE_TEXT, NUMERICAL, MONETORY, CHECKBOX, etc. */
  dataType: string;
  /** Optional stable key GHL uses for the field (defaults from `name`). */
  fieldKey?: string;
  /** Optional group/folder id to file the field under. */
  parentId?: string;
}
