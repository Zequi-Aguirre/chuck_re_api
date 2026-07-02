import {
  AdminUser,
  AdminUserView,
  LedgerEntryView,
  LocationStatusDetail,
  LocationStatusSummary,
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

  // --- admins (JAK-124) ---
  async listAdmins(): Promise<AdminUserView[]> {
    const body = await request<{ admins: AdminUserView[] }>("/admins");
    return body.admins;
  },
  async createAdmin(email: string, password: string): Promise<AdminUserView> {
    const body = await request<{ admin: AdminUserView }>("/admins", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    return body.admin;
  },
  async setAdminActive(id: string, isActive: boolean): Promise<void> {
    const action = isActive ? "activate" : "deactivate";
    await request(`/admins/${encodeURIComponent(id)}/${action}`, { method: "POST" });
  },
};
