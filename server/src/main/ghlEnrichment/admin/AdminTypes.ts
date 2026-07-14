/**
 * Types for the admin dashboard (JAK-113) — the beta onboarding path.
 *
 * The admin dashboard is the UI + auth layer over the existing enrichment
 * services (JAK-102 connections, JAK-109 credits, JAK-112 status). It does NOT
 * reimplement any business logic; these types describe only the auth identity
 * and the safe, credential-free shapes the admin API returns to the SPA.
 */

import { TextCustomerStatus } from "../customers/TextJakeCustomerTypes";
import { CreditBalances } from "../metering/CreditService";

/**
 * Admin privilege level (JAK-125).
 *  - `admin`      — full sub-account management (connections/status), the default.
 *  - `superadmin` — everything an admin can do, PLUS managing other admins
 *                   (add/list/activate/deactivate/reset-password).
 */
export type AdminRole = "admin" | "superadmin";

/** Raw persistence row for the `admin_users` table. */
export interface AdminUserRow {
  id: string;
  email: string;
  /** bcrypt hash — never plaintext, never leaves the server. */
  password_hash: string;
  /** Disabled admins keep their row but can't log in (JAK-124). */
  is_active: boolean;
  /** Privilege level (JAK-125). Defaults to 'admin' at the DB level. */
  role: AdminRole;
  created_at: Date;
  updated_at: Date;
}

/**
 * The admin identity as the rest of the app sees it. Deliberately OMITS
 * `password_hash` so a hash can never be serialized into a response or a log.
 */
export interface AdminUser {
  id: string;
  email: string;
  role: AdminRole;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * The SAFE view of an admin returned by the admin-management API (JAK-124).
 *
 * SECURITY: NEVER carries `password_hash`. It's the only shape the LIST endpoint
 * serializes, so a bcrypt hash can't leak into a response.
 */
export interface AdminUserView {
  id: string;
  email: string;
  isActive: boolean;
  /** Privilege level (JAK-125) — lets the SPA show role + gate the UI. */
  role: AdminRole;
  createdAt: Date;
}

/** JWT payload for an authenticated admin session. */
export interface AdminTokenPayload {
  /** Admin user id (JWT `sub`). */
  sub: string;
  email: string;
  /**
   * Privilege level (JAK-125). Carried in the session so the backend guard and
   * the SPA both know it without a DB round-trip. Old tokens minted before
   * JAK-125 lack this; {@link AdminAuthService.verifyToken} defaults them to
   * the least-privileged 'admin'.
   */
  role: AdminRole;
}

/**
 * The SAFE, masked view of a connection returned to the admin SPA.
 *
 * SECURITY: the GHL API key is NEVER included — not even masked from the real
 * value. `apiKeyMasked` is a constant placeholder that only signals "a key is on
 * file"; the plaintext key is never returned after save, never logged, never
 * shown again (JAK-113 requirement). To rotate it, the operator submits a new
 * one; they can never read the stored one back.
 */
export interface AdminConnectionView {
  id: string;
  locationId: string;
  /** JAK-190 — friendly admin label; null → the UI shows the location id. */
  name: string | null;
  baseUrl: string;
  phoneNumbers: string[];
  status: "active" | "inactive";
  /** JAK-186 — per-location auto-enrichment toggle (opt-in) as the admin sees it. */
  autoEnrichmentEnabled: boolean;
  /** Constant mask — proves a key is stored without ever revealing it. */
  apiKeyMasked: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * The admin view of a tier-1 text-Jake customer (JAK-129) — a texter keyed by
 * sender phone, with their current prepaid credit balance. Distinct from a
 * {@link AdminConnectionView}: a text customer bills against their OWN credit
 * account (its key is the customer id), NOT a GHL connection's locationId, so
 * this is the surface admins use to top up a gateway texter who ran out of
 * credits and has no sub-account of their own.
 */
export interface AdminTextCustomerView {
  /** Customer id — this IS the credit-account key their balance is drawn from. */
  id: string;
  /** Sender phone (E.164) — the stable key for this customer. */
  phone: string;
  /** Optional profile (JAK-146) — captured in the admin UI; null when unset. */
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  /** Contact id in the sub-account handling their texts; null until known. */
  ghlContactId: string | null;
  /**
   * Two-level hold state (JAK-148): 'active' | 'on_hold' | 'deactivated'. The
   * admin card shows it and offers On hold / Deactivate / Reactivate; it never
   * affects the credit balance below.
   */
  status: TextCustomerStatus;
  /**
   * Legacy single balance = the REPORT bucket (JAK-161). Kept so pre-split
   * callers keep reading the primary balance; the admin UI shows {@link credits}.
   */
  creditBalance: number;
  /**
   * The three independent per-feature balances (JAK-161): report / skiptrace /
   * comps. The admin card/table renders all three so an operator sees exactly
   * which bucket a texter is low on.
   */
  credits: CreditBalances;
  createdAt: Date;
  /** Last time we saw activity from this customer (row `modified_at`). */
  lastSeenAt: Date;
}
