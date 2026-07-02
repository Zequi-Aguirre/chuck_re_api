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

export interface AdminUser {
  id: string;
  email: string;
}
