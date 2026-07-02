/**
 * Client-side mirrors of the admin API's safe DTOs (JAK-113 / JAK-112).
 *
 * These match the server's credential-free shapes: no API key ever appears here
 * because the server never sends one. The connection view carries only a masked
 * placeholder.
 */

export type ConnectionStatus = "active" | "inactive";

export interface OutcomeCounts {
  enriched: number;
  skipped: number;
  credit_blocked: number;
  failed: number;
  dead_letter: number;
  total: number;
}

export interface ConnectionStatusView {
  locationId: string;
  status: ConnectionStatus;
  baseUrl: string;
  phoneNumberCount: number;
  provisionedFieldCount: number;
  installedAt: string;
  updatedAt: string;
}

export interface LocationStatusSummary {
  connection: ConnectionStatusView;
  creditBalance: number;
  outcomes: OutcomeCounts;
}

export interface LedgerEntryView {
  id: string;
  amount: number;
  balanceAfter: number;
  reason: string;
  contactId: string | null;
  createdAt: string;
}

export interface EnrichmentEventView {
  contactId: string;
  status: string;
  detail: string | null;
  attemptCount: number;
  enrichedAt: string | null;
  failedAt: string | null;
  updatedAt: string;
}

export interface LocationStatusDetail {
  connection: ConnectionStatusView;
  credits: { balance: number; recent: LedgerEntryView[] };
  enrichment: { counts: OutcomeCounts; recent: EnrichmentEventView[] };
  failures: EnrichmentEventView[];
}

/** Admin privilege level (JAK-125). Mirrors the server's AdminRole. */
export type AdminRole = "admin" | "superadmin";

export interface AdminUser {
  id: string;
  email: string;
  /** Privilege level (JAK-125) — gates the superadmin-only Admins tab. */
  role: AdminRole;
}

/** An admin as the management table sees it (JAK-124) — never a password hash. */
export interface AdminUserView {
  id: string;
  email: string;
  isActive: boolean;
  role: AdminRole;
  createdAt: string;
}
