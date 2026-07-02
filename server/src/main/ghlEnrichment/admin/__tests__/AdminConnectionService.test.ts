import { mock, MockProxy } from "jest-mock-extended";
import { GhlConnectionService } from "../../connections/GhlConnectionService";
import { GhlConnection } from "../../connections/GhlConnectionTypes";
import { GhlInstallLifecycleService } from "../../lifecycle/GhlInstallLifecycleService";
import { CreditService } from "../../metering/CreditService";
import { AdminConnectionService, API_KEY_MASK } from "../AdminConnectionService";

const conn = (over: Partial<GhlConnection> = {}): GhlConnection => ({
  id: "cccccccc-cccc-cccc-cccc-cccccccccccc",
  locationId: "loc_1",
  apiKey: "unit-test-ghl-key",
  baseUrl: "https://services.leadconnectorhq.com",
  phoneNumbers: ["+15551234567"],
  status: "active",
  createdAt: new Date("2026-07-01T00:00:00Z"),
  updatedAt: new Date("2026-07-01T00:00:00Z"),
  ...over,
});

describe("AdminConnectionService", () => {
  let connections: MockProxy<GhlConnectionService>;
  let lifecycle: MockProxy<GhlInstallLifecycleService>;
  let credits: MockProxy<CreditService>;
  let service: AdminConnectionService;

  beforeEach(() => {
    connections = mock<GhlConnectionService>();
    lifecycle = mock<GhlInstallLifecycleService>();
    credits = mock<CreditService>();
    service = new AdminConnectionService(connections, lifecycle, credits);
  });

  it("creates a connection and NEVER returns the plaintext key", async () => {
    connections.createConnection.mockResolvedValue(conn());

    const view = await service.create({
      locationId: "loc_1",
      apiKey: "unit-test-ghl-key",
      baseUrl: "https://services.leadconnectorhq.com",
      phoneNumbers: ["+15551234567"],
    });

    expect(view.apiKeyMasked).toBe(API_KEY_MASK);
    expect(JSON.stringify(view)).not.toContain("unit-test-ghl-key");
    // Delegates the encrypt-at-rest to the connection service.
    expect(connections.createConnection).toHaveBeenCalledWith(
      expect.objectContaining({ locationId: "loc_1", apiKey: "unit-test-ghl-key", status: "active" })
    );
  });

  it("rotates the key on update and still returns only the mask", async () => {
    connections.updateConnection.mockResolvedValue(conn());
    const view = await service.update("loc_1", { apiKey: "rotated-key" });
    expect(connections.updateConnection).toHaveBeenCalledWith(
      "loc_1",
      expect.objectContaining({ apiKey: "rotated-key" })
    );
    expect(view?.apiKeyMasked).toBe(API_KEY_MASK);
    expect(JSON.stringify(view)).not.toContain("unit-test-ghl-key");
  });

  it("returns null when updating an unknown location", async () => {
    connections.updateConnection.mockResolvedValue(null);
    expect(await service.update("missing", { baseUrl: "x" })).toBeNull();
  });

  it("deactivates via the JAK-104/110 inactive path (lifecycle.uninstall)", async () => {
    lifecycle.uninstall.mockResolvedValue(true);
    expect(await service.deactivate("loc_1")).toBe(true);
    expect(lifecycle.uninstall).toHaveBeenCalledWith("loc_1");
    expect(connections.deleteConnection).not.toHaveBeenCalled();
  });

  it("grants credits only for a known location", async () => {
    connections.getByLocationId.mockResolvedValue(conn());
    credits.grantCredits.mockResolvedValue({
      id: "e1",
      location_id: "loc_1",
      amount: 100,
      balance_after: 100,
      reason: "manual_grant",
      contact_id: null,
      created_at: new Date(),
      modified_at: new Date(),
      deleted_at: null,
    });

    const entry = await service.grantCredits("loc_1", 100);
    expect(entry?.balance_after).toBe(100);
    expect(credits.grantCredits).toHaveBeenCalledWith("loc_1", 100, "manual_grant");
  });

  it("does not grant credits to an unknown location", async () => {
    connections.getByLocationId.mockResolvedValue(null);
    expect(await service.grantCredits("missing", 100)).toBeNull();
    expect(credits.grantCredits).not.toHaveBeenCalled();
  });
});
