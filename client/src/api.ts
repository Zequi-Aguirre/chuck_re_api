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
  LlmModelSettingView,
  LlmProvider,
  LocationStatusSummary,
  OrchestratorPromptView,
  ReportPromptView,
  SkipTraceCostView,
  SkipTracePromptView,
  TextCustomerInput,
  TextCustomerView,
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
    patch: { apiKey?: string; baseUrl?: string; phoneNumbers?: string[] }
  ): Promise<void> {
    await request(`/connections/${encodeURIComponent(locationId)}`, {
      method: "PUT",
      body: JSON.stringify(patch),
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
  async createTextCustomer(input: TextCustomerInput): Promise<TextCustomerView> {
    const body = await request<{ customer: TextCustomerView }>("/text-customers", {
      method: "POST",
      body: JSON.stringify(input),
    });
    return body.customer;
  },
  async updateTextCustomer(id: string, input: TextCustomerInput): Promise<TextCustomerView> {
    const body = await request<{ customer: TextCustomerView }>(
      `/text-customers/${encodeURIComponent(id)}`,
      { method: "PUT", body: JSON.stringify(input) }
    );
    return body.customer;
  },
  async grantTextCustomerCredits(
    phone: string,
    amount: number,
    reason: "manual_grant" | "adjustment"
  ): Promise<{ balance: number; customer: TextCustomerView }> {
    return request("/text-customers/credits", {
      method: "POST",
      body: JSON.stringify({ phone, amount, reason }),
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
