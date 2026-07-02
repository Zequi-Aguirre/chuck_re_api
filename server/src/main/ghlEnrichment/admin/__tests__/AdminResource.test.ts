import express, { Express } from "express";
import request from "supertest";
import { mock, MockProxy } from "jest-mock-extended";
import { GhlStatusService } from "../../status/GhlStatusService";
import { AdminAuthService } from "../AdminAuthService";
import { AdminConnectionService, API_KEY_MASK } from "../AdminConnectionService";
import { AdminResource } from "../AdminResource";
import { AdminConnectionView } from "../AdminTypes";

const view = (over: Partial<AdminConnectionView> = {}): AdminConnectionView => ({
  id: "cccccccc-cccc-cccc-cccc-cccccccccccc",
  locationId: "loc_1",
  baseUrl: "https://services.leadconnectorhq.com",
  phoneNumbers: ["+15551234567"],
  status: "active",
  apiKeyMasked: API_KEY_MASK,
  createdAt: new Date("2026-07-01T00:00:00Z"),
  updatedAt: new Date("2026-07-01T00:00:00Z"),
  ...over,
});

describe("AdminResource", () => {
  let auth: MockProxy<AdminAuthService>;
  let connections: MockProxy<AdminConnectionService>;
  let status: MockProxy<GhlStatusService>;
  let app: Express;

  beforeEach(() => {
    auth = mock<AdminAuthService>();
    connections = mock<AdminConnectionService>();
    status = mock<GhlStatusService>();
    // Default: authenticated. Individual tests override to test the gate.
    auth.verifyToken.mockReturnValue({ sub: "admin-id", email: "admin@example.com" });

    app = express();
    app.use(express.json());
    app.use("/api/admin", new AdminResource(auth, connections, status).router);
  });

  const asAdmin = (req: request.Test) => req.set("Authorization", "Bearer valid.token");

  describe("auth gate", () => {
    it("401s every route without a valid session", async () => {
      auth.verifyToken.mockReturnValue(null);
      const res = await request(app).get("/api/admin/connections");
      expect(res.status).toBe(401);
      expect(status.listLocationStatuses).not.toHaveBeenCalled();
    });
  });

  describe("GET /connections", () => {
    it("returns the JAK-112 overview list", async () => {
      status.listLocationStatuses.mockResolvedValue([]);
      const res = await asAdmin(request(app).get("/api/admin/connections"));
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ locations: [] });
    });
  });

  describe("POST /connections", () => {
    it("creates a connection and returns only the masked key", async () => {
      connections.create.mockResolvedValue(view());
      const res = await asAdmin(
        request(app).post("/api/admin/connections").send({
          locationId: "loc_1",
          apiKey: "unit-test-ghl-key",
          baseUrl: "https://services.leadconnectorhq.com",
          phoneNumbers: ["+15551234567"],
        })
      );
      expect(res.status).toBe(201);
      expect(res.body.connection.apiKeyMasked).toBe(API_KEY_MASK);
      expect(JSON.stringify(res.body)).not.toContain("unit-test-ghl-key");
    });

    it("400s when required fields are missing", async () => {
      const res = await asAdmin(
        request(app).post("/api/admin/connections").send({ locationId: "loc_1" })
      );
      expect(res.status).toBe(400);
      expect(connections.create).not.toHaveBeenCalled();
    });

    it("409s when the location is already connected (unique violation)", async () => {
      connections.create.mockRejectedValue(Object.assign(new Error("dup"), { code: "23505" }));
      const res = await asAdmin(
        request(app).post("/api/admin/connections").send({
          locationId: "loc_1",
          apiKey: "k",
          baseUrl: "https://services.leadconnectorhq.com",
        })
      );
      expect(res.status).toBe(409);
    });
  });

  describe("PUT /connections/:id", () => {
    it("rejects a blank apiKey but allows omitting it", async () => {
      const blank = await asAdmin(
        request(app).put("/api/admin/connections/loc_1").send({ apiKey: "  " })
      );
      expect(blank.status).toBe(400);

      connections.update.mockResolvedValue(view());
      const omitted = await asAdmin(
        request(app).put("/api/admin/connections/loc_1").send({ baseUrl: "https://x.co" })
      );
      expect(omitted.status).toBe(200);
      expect(connections.update).toHaveBeenCalledWith(
        "loc_1",
        expect.objectContaining({ apiKey: undefined, baseUrl: "https://x.co" })
      );
    });
  });

  describe("POST /connections/:id/deactivate", () => {
    it("deactivates a known location", async () => {
      connections.deactivate.mockResolvedValue(true);
      const res = await asAdmin(request(app).post("/api/admin/connections/loc_1/deactivate"));
      expect(res.status).toBe(200);
    });

    it("404s an unknown location", async () => {
      connections.deactivate.mockResolvedValue(false);
      const res = await asAdmin(request(app).post("/api/admin/connections/nope/deactivate"));
      expect(res.status).toBe(404);
    });
  });

  describe("POST /connections/:id/credits", () => {
    it("rejects a non-integer or zero amount", async () => {
      for (const amount of [0, 1.5, "abc"]) {
        const res = await asAdmin(
          request(app).post("/api/admin/connections/loc_1/credits").send({ amount })
        );
        expect(res.status).toBe(400);
      }
      expect(connections.grantCredits).not.toHaveBeenCalled();
    });

    it("grants a valid amount", async () => {
      connections.grantCredits.mockResolvedValue({
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
      const res = await asAdmin(
        request(app).post("/api/admin/connections/loc_1/credits").send({ amount: 100 })
      );
      expect(res.status).toBe(200);
      expect(res.body.balance).toBe(100);
    });
  });

  // --- Admin management (JAK-124) -------------------------------------------

  const adminView = (over: Partial<{ id: string; email: string; isActive: boolean }> = {}) => ({
    id: "admin-id",
    email: "admin@example.com",
    isActive: true,
    createdAt: new Date("2026-07-01T00:00:00Z"),
    ...over,
  });

  describe("GET /admins", () => {
    it("is behind the auth gate", async () => {
      auth.verifyToken.mockReturnValue(null);
      const res = await request(app).get("/api/admin/admins");
      expect(res.status).toBe(401);
      expect(auth.listAdmins).not.toHaveBeenCalled();
    });

    it("returns admin views and never leaks a password hash", async () => {
      auth.listAdmins.mockResolvedValue([adminView(), adminView({ id: "two", email: "b@x.co" })]);
      const res = await asAdmin(request(app).get("/api/admin/admins"));
      expect(res.status).toBe(200);
      expect(res.body.admins).toHaveLength(2);
      expect(JSON.stringify(res.body)).not.toContain("password_hash");
    });
  });

  describe("POST /admins", () => {
    it("400s an invalid email", async () => {
      const res = await asAdmin(
        request(app).post("/api/admin/admins").send({ email: "not-an-email", password: "unit-test-long-pw" })
      );
      expect(res.status).toBe(400);
      expect(auth.createAdmin).not.toHaveBeenCalled();
    });

    it("400s a too-short password", async () => {
      const res = await asAdmin(
        request(app).post("/api/admin/admins").send({ email: "new@example.com", password: "short" })
      );
      expect(res.status).toBe(400);
      expect(auth.createAdmin).not.toHaveBeenCalled();
    });

    it("409s a duplicate email", async () => {
      auth.emailExists.mockResolvedValue(true);
      const res = await asAdmin(
        request(app).post("/api/admin/admins").send({ email: "dupe@example.com", password: "unit-test-long-pw" })
      );
      expect(res.status).toBe(409);
      expect(auth.createAdmin).not.toHaveBeenCalled();
    });

    it("creates an admin and returns the hash-free view", async () => {
      auth.emailExists.mockResolvedValue(false);
      auth.createAdmin.mockResolvedValue(adminView({ id: "new-id", email: "new@example.com" }));
      const res = await asAdmin(
        request(app).post("/api/admin/admins").send({ email: "New@Example.com", password: "unit-test-pw-123" })
      );
      expect(res.status).toBe(201);
      expect(res.body.admin.email).toBe("new@example.com");
      // Email is normalized to lowercase before hashing/insert.
      expect(auth.createAdmin).toHaveBeenCalledWith("new@example.com", "unit-test-pw-123");
      // Neither the plaintext password nor any hash is echoed back.
      expect(JSON.stringify(res.body)).not.toContain("unit-test-pw-123");
      expect(JSON.stringify(res.body)).not.toContain("password_hash");
    });
  });

  describe("POST /admins/:id/deactivate", () => {
    it("refuses to deactivate your own logged-in account (lockout guard)", async () => {
      // The session in these tests is sub: "admin-id".
      const res = await asAdmin(request(app).post("/api/admin/admins/admin-id/deactivate"));
      expect(res.status).toBe(400);
      expect(auth.setAdminActive).not.toHaveBeenCalled();
    });

    it("deactivates another admin", async () => {
      auth.setAdminActive.mockResolvedValue(adminView({ id: "other", isActive: false }));
      const res = await asAdmin(request(app).post("/api/admin/admins/other/deactivate"));
      expect(res.status).toBe(200);
      expect(res.body.admin.isActive).toBe(false);
      expect(auth.setAdminActive).toHaveBeenCalledWith("other", false);
    });

    it("404s an unknown admin", async () => {
      auth.setAdminActive.mockResolvedValue(null);
      const res = await asAdmin(request(app).post("/api/admin/admins/nope/deactivate"));
      expect(res.status).toBe(404);
    });
  });

  describe("POST /admins/:id/activate", () => {
    it("re-enables an admin", async () => {
      auth.setAdminActive.mockResolvedValue(adminView({ id: "other", isActive: true }));
      const res = await asAdmin(request(app).post("/api/admin/admins/other/activate"));
      expect(res.status).toBe(200);
      expect(auth.setAdminActive).toHaveBeenCalledWith("other", true);
    });
  });
});
