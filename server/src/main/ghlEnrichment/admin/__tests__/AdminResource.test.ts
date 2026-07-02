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
});
