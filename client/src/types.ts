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

/**
 * A tier-1 text-Jake customer as the admin table sees it (JAK-129) — a texter
 * keyed by sender phone with their current credit balance. Mirrors the server's
 * AdminTextCustomerView. The `id` is also the credit-account key their balance
 * is drawn from.
 */
export interface TextCustomerView {
  id: string;
  phone: string;
  ghlContactId: string | null;
  creditBalance: number;
  createdAt: string;
  lastSeenAt: string;
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

/**
 * The editable AI STYLE/FORMAT prompt for the "Jake Property Report" (JAK-131).
 * `prompt` is the effective value (the stored edit, or the code default when
 * `isDefault`). The hard guardrails (no emojis / only-provided-values /
 * GoTextJake.com footer) are NOT part of this — the server enforces them.
 */
export interface ReportPromptView {
  prompt: string;
  isDefault: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}

/**
 * The editable AI STYLE/CLASSIFICATION prompt for the text-Jake orchestrator /
 * router (JAK-135). `prompt` is the effective value (the stored edit, or the code
 * default when `isDefault`). The hard routing rules (fixed intent set, JSON-only
 * output, never-invent-an-address) are NOT part of this — the router client
 * appends them, so an edit here can never break routing.
 */
export interface OrchestratorPromptView {
  prompt: string;
  isDefault: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}
