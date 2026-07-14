// JAK-134 — Conversation memory + property lookup cache types.

/** Direction of a stored conversation message. */
export type MessageDirection = "inbound" | "outbound";

/**
 * Raw persistence row for `text_jake_conversation_messages` (JAK-134). One row
 * per inbound or outbound message, ordered per phone. Mirrors the house stores:
 * snake_case columns, timestamptz timestamps.
 */
export interface ConversationMessageRow {
  id: string;
  customer_id: string;
  phone: string;
  direction: MessageDirection;
  body: string;
  /** The normalized address parsed from this message; null when not an address. */
  resolved_address: string | null;
  /** The own_number location this was handled on; null for the shared gateway. */
  tenant_location_id: string | null;
  /** The resolved text mode ('gateway' | 'own_number'). */
  text_mode: string | null;
  created_at: Date;
}

/**
 * Raw persistence row for `text_jake_lookups` (JAK-134) — a snapshot of one paid
 * PropertySearch result, the backing store for the free re-serve rule and the
 * per-phone "Nth address" order index.
 */
export interface LookupRow {
  id: string;
  customer_id: string;
  phone: string;
  message_id: string | null;
  normalized_address: string;
  /** Canonical cache key (lower-cased, whitespace-collapsed). */
  address_key: string;
  /** 1-based per-phone order of resolved addresses (for JAK-135). */
  order_index: number;
  property_id: string | null;
  /** The FULL verified PropertySearch record (JAK-132 hands the whole thing on). */
  property_record: unknown;
  /** The exact SMS we sent, so a free re-serve returns the identical report. */
  report_text: string;
  fetched_at: Date;
  created_at: Date;
}

/**
 * Canonical cache key for an address: lower-cased and whitespace-collapsed, so
 * casing/spacing variants of the same address hit the same cache row. The
 * display form (the normalized address) is stored separately.
 */
export function addressCacheKey(address: string): string {
  return String(address).trim().toLowerCase().replace(/\s+/g, " ");
}
