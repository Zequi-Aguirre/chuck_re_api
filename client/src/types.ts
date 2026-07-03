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
  /** Optional profile (JAK-146) — captured in the admin UI; null when unset. */
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  ghlContactId: string | null;
  creditBalance: number;
  createdAt: string;
  lastSeenAt: string;
}

/** The editable identity + profile for a text customer (JAK-146). */
export interface TextCustomerInput {
  phone: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
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

/**
 * The editable STYLE prompt for the text-Jake skip-trace specialist (JAK-136).
 * `prompt` is the effective value (the stored edit, or the code default when
 * `isDefault`). The hard guardrails (no emojis / only-provided-values /
 * GoTextJake.com footer) are NOT part of this — the specialist writer enforces
 * them, so an edit here can never make Jake invent contact info or drop the footer.
 */
export interface SkipTracePromptView {
  prompt: string;
  isDefault: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}

/**
 * The editable CREDIT COST of one text-Jake skip trace (JAK-136). `value` is the
 * effective cost in credits (the stored edit, or the code default when
 * `isDefault`). A skip trace is a paid call, so the cost is always a positive
 * integer — it can never be set to free.
 */
export interface SkipTraceCostView {
  value: number;
  isDefault: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}

/**
 * The editable STYLE prompt for the text-Jake comps specialist (JAK-137).
 * `prompt` is the effective value (the stored edit, or the code default when
 * `isDefault`). The hard guardrails (no emojis / only-provided-values /
 * GoTextJake.com footer) are NOT part of this — the specialist writer enforces
 * them, so an edit here can never make Jake invent a comp or drop the footer.
 */
export interface CompsPromptView {
  prompt: string;
  isDefault: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}

/**
 * The editable CREDIT COST of one text-Jake comps pull (JAK-137). `value` is the
 * effective cost in credits (the stored edit, or the code default when
 * `isDefault`). A comps pull is a paid call, so the cost is always a positive
 * integer — it can never be set to free.
 */
export interface CompsCostView {
  value: number;
  isDefault: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}

/**
 * The comp PARAMETERS that shape a comps pull (JAK-137): search radius, number of
 * comps, timeframe (months), and bed/bath/sqft tolerance. Admins set the defaults;
 * a texter can override them in the message. Server-clamped to sane bounds.
 */
export interface CompParams {
  radiusMiles: number;
  count: number;
  monthsBack: number;
  bedsTolerance: number;
  bathsTolerance: number;
  sqftTolerancePct: number;
}

/**
 * The editable DEFAULT comp parameters (JAK-137). `params` is the effective set
 * (the stored edit, or the code default when `isDefault`).
 */
export interface CompsParamsView {
  params: CompParams;
  isDefault: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}

/** The LLM providers a prompt surface can select (JAK-143). Mirrors the server. */
export type LlmProvider = "openai" | "anthropic";

/**
 * The per-prompt PROVIDER + MODEL selection for one editable-prompt surface
 * (JAK-143). `provider`/`model` are the stored OVERRIDE (null while inheriting the
 * global Doppler default); `effectiveProvider`/`effectiveModel` are what the
 * surface runs on right now; `defaultProvider`/`defaultModel` are the global
 * default shown when nothing is pinned. `providerKeyConfigured` is booleans ONLY —
 * so the picker can note "provider key not configured — will use fallback" without
 * ever seeing a key. NO api key is ever part of this shape; keys stay in Doppler.
 */
export interface LlmModelSettingView {
  provider: LlmProvider | null;
  model: string | null;
  isDefault: boolean;
  effectiveProvider: LlmProvider;
  effectiveModel: string;
  defaultProvider: LlmProvider;
  defaultModel: string;
  providerKeyConfigured: Record<LlmProvider, boolean>;
  updatedAt: string | null;
  updatedBy: string | null;
}
