import {
  AdminRole,
  AdminUser,
  AdminUserView,
  LedgerEntryView,
  LocationStatusDetail,
  CompParams,
  CompsCostView,
  CompsParamsView,
  CompsPromptView,
  CompsSelectionPromptView,
  CreditBalances,
  CreditDefaultView,
  CreditType,
  OutOfCreditsMessageView,
  LlmModelSettingView,
  LlmProvider,
  LocationStatusSummary,
  OnboardingPromptView,
  OrchestratorPromptView,
  ReportPromptView,
  FooterView,
  SkipTraceCostView,
  SkipTracePromptView,
  FindContactResult,
  TextCustomerInput,
  TextCustomerStatusResult,
  TextCustomerView,
  TextCustomerWriteResult,
} from "./types";

/**
 * Thin fetch wrapper for the admin API (JAK-113).
 *
 * Every request sends the session cookie (`credentials: "include"`) — the JWT
 * lives in an httpOnly cookie, never in JS. A 401 throws {@link UnauthorizedError}
 * so the app can bounce to the login screen. Non-2xx responses surface the
 * server's `error` message.
 */
const BASE = "/api/admin";

export class UnauthorizedError extends Error {}
export class ApiError extends Error {}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(BASE + path, {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...init,
  });

  if (res.status === 401) {
    throw new UnauthorizedError("Not authenticated");
  }

  let body: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  if (!res.ok) {
    const message =
      (body && typeof body === "object" && "error" in body
        ? String((body as { error: unknown }).error)
        : `Request failed (${res.status})`) || `Request failed (${res.status})`;
    throw new ApiError(message);
  }

  return body as T;
}

export const api = {
  // --- auth ---
  async login(email: string, password: string): Promise<AdminUser> {
    const body = await request<{ user: AdminUser }>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    return body.user;
  },
  async logout(): Promise<void> {
    await request("/auth/logout", { method: "POST" });
  },
  async me(): Promise<AdminUser> {
    const body = await request<{ user: AdminUser }>("/auth/me");
    return body.user;
  },

  // --- connections ---
  async listConnections(): Promise<LocationStatusSummary[]> {
    const body = await request<{ locations: LocationStatusSummary[] }>("/connections");
    return body.locations;
  },
  async getConnection(locationId: string): Promise<LocationStatusDetail> {
    return request<LocationStatusDetail>(`/connections/${encodeURIComponent(locationId)}`);
  },
  async createConnection(input: {
    locationId: string;
    apiKey: string;
    baseUrl: string;
    phoneNumbers: string[];
  }): Promise<void> {
    await request("/connections", { method: "POST", body: JSON.stringify(input) });
  },
  async updateConnection(
    locationId: string,
    patch: {
      apiKey?: string;
      baseUrl?: string;
      phoneNumbers?: string[];
      // JAK-186 — flip the per-location auto-enrichment toggle.
      autoEnrichmentEnabled?: boolean;
    }
  ): Promise<void> {
    await request(`/connections/${encodeURIComponent(locationId)}`, {
      method: "PUT",
      body: JSON.stringify(patch),
    });
  },
  /** JAK-186 — set the per-location auto-enrichment toggle on/off. */
  async setAutoEnrichment(locationId: string, enabled: boolean): Promise<void> {
    await request(`/connections/${encodeURIComponent(locationId)}`, {
      method: "PUT",
      body: JSON.stringify({ autoEnrichmentEnabled: enabled }),
    });
  },
  async deactivate(locationId: string): Promise<void> {
    await request(`/connections/${encodeURIComponent(locationId)}/deactivate`, { method: "POST" });
  },
  async activate(locationId: string): Promise<void> {
    await request(`/connections/${encodeURIComponent(locationId)}/activate`, { method: "POST" });
  },
  async deleteConnection(locationId: string): Promise<void> {
    await request(`/connections/${encodeURIComponent(locationId)}`, { method: "DELETE" });
  },

  // --- footers (JAK-188) ---
  async listFooters(): Promise<FooterView[]> {
    const body = await request<{ footers: FooterView[] }>("/footers");
    return body.footers;
  },
  async createFooter(input: { text: string; active?: boolean }): Promise<FooterView> {
    const body = await request<{ footer: FooterView }>("/footers", {
      method: "POST",
      body: JSON.stringify(input),
    });
    return body.footer;
  },
  async updateFooter(
    id: string,
    patch: { text?: string; active?: boolean }
  ): Promise<FooterView> {
    const body = await request<{ footer: FooterView }>(`/footers/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify(patch),
    });
    return body.footer;
  },
  async deleteFooter(id: string): Promise<void> {
    await request(`/footers/${encodeURIComponent(id)}`, { method: "DELETE" });
  },
  async grantCredits(
    locationId: string,
    amount: number,
    reason: "manual_grant" | "adjustment"
  ): Promise<LedgerEntryView & { balance: number }> {
    return request(`/connections/${encodeURIComponent(locationId)}/credits`, {
      method: "POST",
      body: JSON.stringify({ amount, reason }),
    });
  },

  // --- text-Jake customers (JAK-129) ---
  async listTextCustomers(): Promise<TextCustomerView[]> {
    const body = await request<{ customers: TextCustomerView[] }>("/text-customers");
    return body.customers;
  },
  // Create / edit a texter's profile (JAK-146): name + optional email, phone required.
  // The response carries the GHL sync outcome too (JAK-147) so the form can show it.
  async createTextCustomer(input: TextCustomerInput): Promise<TextCustomerWriteResult> {
    return request<TextCustomerWriteResult>("/text-customers", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },
  async updateTextCustomer(id: string, input: TextCustomerInput): Promise<TextCustomerWriteResult> {
    return request<TextCustomerWriteResult>(`/text-customers/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify(input),
    });
  },
  // Look up an existing Jake-sub-account contact by phone, to prefill the form (JAK-147).
  async findTextCustomerContact(phone: string): Promise<FindContactResult> {
    return request<FindContactResult>("/text-customers/find-contact", {
      method: "POST",
      body: JSON.stringify({ phone }),
    });
  },
  // Two-level hold controls (JAK-148). Server-side only (JAK-remove-ghl-hold):
  // none of these write to GHL and none touch credits.
  //   hold       — SOFT: Jake replies "on hold", no charge.
  //   deactivate — HARD: Jake refuses to process the inbound, no charge.
  //   reactivate — back to active: normal processing resumes.
  async holdTextCustomer(id: string): Promise<TextCustomerStatusResult> {
    return request<TextCustomerStatusResult>(`/text-customers/${encodeURIComponent(id)}/hold`, {
      method: "POST",
    });
  },
  async deactivateTextCustomer(id: string): Promise<TextCustomerStatusResult> {
    return request<TextCustomerStatusResult>(`/text-customers/${encodeURIComponent(id)}/deactivate`, {
      method: "POST",
    });
  },
  async reactivateTextCustomer(id: string): Promise<TextCustomerStatusResult> {
    return request<TextCustomerStatusResult>(`/text-customers/${encodeURIComponent(id)}/reactivate`, {
      method: "POST",
    });
  },
  // Grant/adjust credits in ONE feature bucket (JAK-161/JAK-162): report /
  // skiptrace / comps. The server credits the texter's own account by phone.
  async grantTextCustomerCredits(
    phone: string,
    amount: number,
    reason: "manual_grant" | "adjustment",
    type: CreditType
  ): Promise<{ balance: number; customer: TextCustomerView }> {
    return request("/text-customers/credits", {
      method: "POST",
      body: JSON.stringify({ phone, amount, reason, type }),
    });
  },
  // Reset a texter's three buckets to the EFFECTIVE new-customer default grants
  // (JAK-reset-credits-button): report / skiptrace / comps. The server sets each
  // bucket to its admin-editable defaultGrant value (what a new customer gets) by
  // granting/charging the delta, and returns all three resulting balances.
  async resetTextCustomerCredits(
    phone: string
  ): Promise<{ customer: TextCustomerView; credits: CreditBalances }> {
    return request("/text-customers/credits/reset", {
      method: "POST",
      body: JSON.stringify({ phone }),
    });
  },

  // --- AI prompt (JAK-131) ---
  async getReportPrompt(): Promise<ReportPromptView> {
    return request<ReportPromptView>("/report-prompt");
  },
  async updateReportPrompt(prompt: string): Promise<ReportPromptView> {
    return request<ReportPromptView>("/report-prompt", {
      method: "PUT",
      body: JSON.stringify({ prompt }),
    });
  },
  async resetReportPrompt(): Promise<ReportPromptView> {
    return request<ReportPromptView>("/report-prompt/reset", { method: "POST" });
  },

  // --- Onboarding email ask (JAK-first-text-welcome) ---
  async getOnboardingPrompt(): Promise<OnboardingPromptView> {
    return request<OnboardingPromptView>("/onboarding-prompt");
  },
  async updateOnboardingPrompt(prompt: string): Promise<OnboardingPromptView> {
    return request<OnboardingPromptView>("/onboarding-prompt", {
      method: "PUT",
      body: JSON.stringify({ prompt }),
    });
  },
  async resetOnboardingPrompt(): Promise<OnboardingPromptView> {
    return request<OnboardingPromptView>("/onboarding-prompt/reset", { method: "POST" });
  },

  // --- Orchestrator/router prompt (JAK-135) ---
  async getOrchestratorPrompt(): Promise<OrchestratorPromptView> {
    return request<OrchestratorPromptView>("/orchestrator-prompt");
  },
  async updateOrchestratorPrompt(prompt: string): Promise<OrchestratorPromptView> {
    return request<OrchestratorPromptView>("/orchestrator-prompt", {
      method: "PUT",
      body: JSON.stringify({ prompt }),
    });
  },
  async resetOrchestratorPrompt(): Promise<OrchestratorPromptView> {
    return request<OrchestratorPromptView>("/orchestrator-prompt/reset", { method: "POST" });
  },

  // --- Skip-trace specialist (JAK-136) ---
  async getSkipTracePrompt(): Promise<SkipTracePromptView> {
    return request<SkipTracePromptView>("/skiptrace-prompt");
  },
  async updateSkipTracePrompt(prompt: string): Promise<SkipTracePromptView> {
    return request<SkipTracePromptView>("/skiptrace-prompt", {
      method: "PUT",
      body: JSON.stringify({ prompt }),
    });
  },
  async resetSkipTracePrompt(): Promise<SkipTracePromptView> {
    return request<SkipTracePromptView>("/skiptrace-prompt/reset", { method: "POST" });
  },
  async getSkipTraceCost(): Promise<SkipTraceCostView> {
    return request<SkipTraceCostView>("/skiptrace-cost");
  },
  async updateSkipTraceCost(credits: number): Promise<SkipTraceCostView> {
    return request<SkipTraceCostView>("/skiptrace-cost", {
      method: "PUT",
      body: JSON.stringify({ credits }),
    });
  },
  async resetSkipTraceCost(): Promise<SkipTraceCostView> {
    return request<SkipTraceCostView>("/skiptrace-cost/reset", { method: "POST" });
  },

  // --- Comps specialist (JAK-137) ---
  async getCompsPrompt(): Promise<CompsPromptView> {
    return request<CompsPromptView>("/comps-prompt");
  },
  async updateCompsPrompt(prompt: string): Promise<CompsPromptView> {
    return request<CompsPromptView>("/comps-prompt", {
      method: "PUT",
      body: JSON.stringify({ prompt }),
    });
  },
  async resetCompsPrompt(): Promise<CompsPromptView> {
    return request<CompsPromptView>("/comps-prompt/reset", { method: "POST" });
  },
  // Comps SELECTION-engine prompt (JAK-164).
  async getCompsSelectionPrompt(): Promise<CompsSelectionPromptView> {
    return request<CompsSelectionPromptView>("/comps-selection-prompt");
  },
  async updateCompsSelectionPrompt(prompt: string): Promise<CompsSelectionPromptView> {
    return request<CompsSelectionPromptView>("/comps-selection-prompt", {
      method: "PUT",
      body: JSON.stringify({ prompt }),
    });
  },
  async resetCompsSelectionPrompt(): Promise<CompsSelectionPromptView> {
    return request<CompsSelectionPromptView>("/comps-selection-prompt/reset", { method: "POST" });
  },
  async getCompsCost(): Promise<CompsCostView> {
    return request<CompsCostView>("/comps-cost");
  },
  async updateCompsCost(credits: number): Promise<CompsCostView> {
    return request<CompsCostView>("/comps-cost", {
      method: "PUT",
      body: JSON.stringify({ credits }),
    });
  },
  async resetCompsCost(): Promise<CompsCostView> {
    return request<CompsCostView>("/comps-cost/reset", { method: "POST" });
  },
  async getCompsParams(): Promise<CompsParamsView> {
    return request<CompsParamsView>("/comps-params");
  },
  async updateCompsParams(params: CompParams): Promise<CompsParamsView> {
    return request<CompsParamsView>("/comps-params", {
      method: "PUT",
      body: JSON.stringify(params),
    });
  },
  async resetCompsParams(): Promise<CompsParamsView> {
    return request<CompsParamsView>("/comps-params/reset", { method: "POST" });
  },

  // --- Per-feature credit settings (JAK-161/JAK-162) ---
  // The NEW-CUSTOMER default grants + the OUT-OF-CREDITS messages for each of the
  // three buckets (report / skiptrace / comps). Each GET returns all three; PUT /
  // reset act on ONE bucket keyed by `type`. Session-guarded, no secrets.
  async getCreditDefaults(): Promise<CreditDefaultView[]> {
    const body = await request<{ defaults: CreditDefaultView[] }>("/credit-defaults");
    return body.defaults;
  },
  async updateCreditDefault(type: CreditType, credits: number): Promise<CreditDefaultView> {
    return request<CreditDefaultView>("/credit-defaults", {
      method: "PUT",
      body: JSON.stringify({ type, credits }),
    });
  },
  async resetCreditDefault(type: CreditType): Promise<CreditDefaultView> {
    return request<CreditDefaultView>("/credit-defaults/reset", {
      method: "POST",
      body: JSON.stringify({ type }),
    });
  },
  async getOutOfCreditsMessages(): Promise<OutOfCreditsMessageView[]> {
    const body = await request<{ messages: OutOfCreditsMessageView[] }>("/out-of-credits-messages");
    return body.messages;
  },
  async updateOutOfCreditsMessage(type: CreditType, message: string): Promise<OutOfCreditsMessageView> {
    return request<OutOfCreditsMessageView>("/out-of-credits-messages", {
      method: "PUT",
      body: JSON.stringify({ type, message }),
    });
  },
  async resetOutOfCreditsMessage(type: CreditType): Promise<OutOfCreditsMessageView> {
    return request<OutOfCreditsMessageView>("/out-of-credits-messages/reset", {
      method: "POST",
      body: JSON.stringify({ type }),
    });
  },

  // --- Per-prompt provider + model picker (JAK-143) ---
  // Each surface exposes GET/PUT/reset over its own provider+model selection. PUT
  // sends only a provider + optional model — NEVER an api key (keys stay Doppler).
  async getReportModel(): Promise<LlmModelSettingView> {
    return request<LlmModelSettingView>("/report-model");
  },
  async updateReportModel(provider: LlmProvider, model: string): Promise<LlmModelSettingView> {
    return request<LlmModelSettingView>("/report-model", {
      method: "PUT",
      body: JSON.stringify({ provider, model }),
    });
  },
  async resetReportModel(): Promise<LlmModelSettingView> {
    return request<LlmModelSettingView>("/report-model/reset", { method: "POST" });
  },

  async getOrchestratorModel(): Promise<LlmModelSettingView> {
    return request<LlmModelSettingView>("/orchestrator-model");
  },
  async updateOrchestratorModel(provider: LlmProvider, model: string): Promise<LlmModelSettingView> {
    return request<LlmModelSettingView>("/orchestrator-model", {
      method: "PUT",
      body: JSON.stringify({ provider, model }),
    });
  },
  async resetOrchestratorModel(): Promise<LlmModelSettingView> {
    return request<LlmModelSettingView>("/orchestrator-model/reset", { method: "POST" });
  },

  async getSkipTraceModel(): Promise<LlmModelSettingView> {
    return request<LlmModelSettingView>("/skiptrace-model");
  },
  async updateSkipTraceModel(provider: LlmProvider, model: string): Promise<LlmModelSettingView> {
    return request<LlmModelSettingView>("/skiptrace-model", {
      method: "PUT",
      body: JSON.stringify({ provider, model }),
    });
  },
  async resetSkipTraceModel(): Promise<LlmModelSettingView> {
    return request<LlmModelSettingView>("/skiptrace-model/reset", { method: "POST" });
  },

  async getCompsModel(): Promise<LlmModelSettingView> {
    return request<LlmModelSettingView>("/comps-model");
  },
  async updateCompsModel(provider: LlmProvider, model: string): Promise<LlmModelSettingView> {
    return request<LlmModelSettingView>("/comps-model", {
      method: "PUT",
      body: JSON.stringify({ provider, model }),
    });
  },
  async resetCompsModel(): Promise<LlmModelSettingView> {
    return request<LlmModelSettingView>("/comps-model/reset", { method: "POST" });
  },

  async getCompsSelectionModel(): Promise<LlmModelSettingView> {
    return request<LlmModelSettingView>("/comps-selection-model");
  },
  async updateCompsSelectionModel(provider: LlmProvider, model: string): Promise<LlmModelSettingView> {
    return request<LlmModelSettingView>("/comps-selection-model", {
      method: "PUT",
      body: JSON.stringify({ provider, model }),
    });
  },
  async resetCompsSelectionModel(): Promise<LlmModelSettingView> {
    return request<LlmModelSettingView>("/comps-selection-model/reset", { method: "POST" });
  },

  // --- admins (JAK-124) ---
  async listAdmins(): Promise<AdminUserView[]> {
    const body = await request<{ admins: AdminUserView[] }>("/admins");
    return body.admins;
  },
  async createAdmin(email: string, password: string, role: AdminRole): Promise<AdminUserView> {
    const body = await request<{ admin: AdminUserView }>("/admins", {
      method: "POST",
      body: JSON.stringify({ email, password, role }),
    });
    return body.admin;
  },
  async setAdminActive(id: string, isActive: boolean): Promise<void> {
    const action = isActive ? "activate" : "deactivate";
    await request(`/admins/${encodeURIComponent(id)}/${action}`, { method: "POST" });
  },
  async resetAdminPassword(id: string, password: string): Promise<void> {
    await request(`/admins/${encodeURIComponent(id)}/password`, {
      method: "POST",
      body: JSON.stringify({ password }),
    });
  },
};
