/**
 * Types for the per-location GHL connection/credential store (JAK-102).
 *
 * A "connection" is the SINGLE source of GHL credentials for BOTH the
 * enrichment webhook path AND text-Jake (JAK-114). It abstracts "how we
 * authenticate to a sub-account" so callers don't care whether it's a pasted
 * API key (beta) or an OAuth token (post-beta).
 */

/**
 * A resolved connection as callers see it: the API key is DECRYPTED here, ready
 * to use. Never log or persist this shape as-is.
 */
export interface GhlConnection {
  id: string;
  /** GHL sub-account (location) id — unique per connection. */
  locationId: string;
  /** JAK-190 — friendly admin label; null falls back to the location id in the UI. */
  name: string | null;
  /** Decrypted GHL API key (beta auth). */
  apiKey: string;
  /** Per-location GHL API base URL. */
  baseUrl: string;
  /** Phone number(s) associated with this location, E.164, for text-Jake routing. */
  phoneNumbers: string[];
  /** active | inactive — inactive stops processing (uninstall, JAK-105). */
  status: GhlConnectionStatus;
  /**
   * How text-Jake runs for this customer (JAK-115). 'gateway' (default): texts go
   * through Zequi's shared Jake sub-account on the master gateway key. 'own_number'
   * (opt-in): texts run INSIDE this sub-account on THIS connection's per-tenant key
   * + assigned number (the JAK-114 path). Optional in this shape (the service
   * always populates it from the row); treat absent as the 'gateway' default.
   */
  textMode?: GhlTextMode;
  /**
   * JAK-186 — per-location contact-created auto-enrichment toggle (epic JAK-180).
   * OPT-IN: false until an admin turns it on. The JAK-182 endpoint enqueues an
   * enrichment job only when the connection is active AND this is true.
   */
  autoEnrichmentEnabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export type GhlConnectionStatus = "active" | "inactive";

export type GhlTextMode = "gateway" | "own_number";

/** The default text mode for any connection that hasn't opted into own_number. */
export const DEFAULT_TEXT_MODE: GhlTextMode = "gateway";

/** Input for creating a connection. `apiKey` is plaintext; the service encrypts it. */
export interface CreateGhlConnectionInput {
  locationId: string;
  /** JAK-190 — optional friendly label; omitted → null (UI shows the location id). */
  name?: string | null;
  apiKey: string;
  baseUrl: string;
  phoneNumbers?: string[];
  status?: GhlConnectionStatus;
  /** Text mode for this customer (JAK-115). Defaults to 'gateway' when omitted. */
  textMode?: GhlTextMode;
  /** JAK-186 auto-enrichment toggle. Defaults to false (opt-in) when omitted. */
  autoEnrichmentEnabled?: boolean;
}

/**
 * Patch for updating a connection. Only provided fields change. A provided
 * `apiKey` (plaintext) is re-encrypted; omit it to leave the stored key intact.
 */
export interface UpdateGhlConnectionInput {
  /** JAK-190 — edit the friendly label. Pass "" / null to clear it. */
  name?: string | null;
  apiKey?: string;
  baseUrl?: string;
  phoneNumbers?: string[];
  status?: GhlConnectionStatus;
  /** Switch this customer between 'gateway' and 'own_number' text mode (JAK-115). */
  textMode?: GhlTextMode;
  /** Flip the JAK-186 per-location auto-enrichment toggle on/off. */
  autoEnrichmentEnabled?: boolean;
}
