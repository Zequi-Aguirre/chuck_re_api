/**
 * Types for the admin-managed rotating reply footers (JAK-188).
 *
 * Replaces the single hardcoded reply footer (JAK-157/158) with a GLOBAL pool of
 * footers an admin curates; a uniformly-random ACTIVE footer is chosen per
 * outbound message. This module owns only the shapes; the persistence is
 * {@link import("./FooterStore").FooterStore} and the business surface (random
 * pick + fallback + admin CRUD) is {@link import("./FooterService").FooterService}.
 */

/** Raw persistence row for the `footers` table. */
export interface FooterRow {
  id: string;
  text: string;
  active: boolean;
  created_at: Date;
  updated_at: Date;
}

/** A footer as callers/admin SPA see it (camelCase; no secrets). */
export interface Footer {
  id: string;
  text: string;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** Input for creating a footer. `active` defaults to true when omitted. */
export interface CreateFooterInput {
  text: string;
  active?: boolean;
}

/** Patch for updating a footer. Only provided fields change. */
export interface UpdateFooterInput {
  text?: string;
  active?: boolean;
}
