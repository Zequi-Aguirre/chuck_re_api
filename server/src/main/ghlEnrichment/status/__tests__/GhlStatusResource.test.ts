import express, { Express } from "express";
import request from "supertest";
import { mock, MockProxy } from "jest-mock-extended";
import { EnvConfig } from "../../../config/envConfig";
import { GhlStatusService } from "../GhlStatusService";
import { GhlStatusResource } from "../GhlStatusResource";
import { LocationStatusDetail, LocationStatusSummary } from "../GhlStatusTypes";

// Obviously-fake, generated-looking key. NOT a real credential.
const FAKE_MASTER_KEY = "master_fake_unit_test_key_00000000";

const summary = (): LocationStatusSummary => ({
  connection: {
    locationId: "loc_1",
    name: null,
    status: "active",
    baseUrl: "https://services.leadconnectorhq.com",
    phoneNumberCount: 1,
    provisionedFieldCount: 7,
    autoEnrichmentEnabled: false,
    installedAt: new Date("2026-06-01T00:00:00Z"),
    updatedAt: new Date("2026-06-15T00:00:00Z"),
  },
  creditBalance: 41,
  outcomes: { enriched: 5, skipped: 0, credit_blocked: 0, failed: 2, dead_letter: 0, total: 7 },
});

const detail = (): LocationStatusDetail => ({
  connection: summary().connection,
  credits: { balance: 41, recent: [] },
  enrichment: { counts: summary().outcomes, recent: [] },
  failures: [],
});

describe("GhlStatusResource", () => {
  let status: MockProxy<GhlStatusService>;
  let app: Express;

  beforeEach(() => {
    status = mock<GhlStatusService>();
    const env = { masterApiKey: FAKE_MASTER_KEY } as unknown as EnvConfig;
    const resource = new GhlStatusResource(env, status);
    app = express();
    app.use("/api/ghl/status", resource.router);
  });

  const auth = (req: request.Test) => req.set("x-master-api-key", FAKE_MASTER_KEY);

  describe("auth", () => {
    it("rejects a request with no master key (401) and does not touch the service", async () => {
      const res = await request(app).get("/api/ghl/status/locations");
      expect(res.status).toBe(401);
      expect(status.listLocationStatuses).not.toHaveBeenCalled();
    });

    it("rejects a request with the wrong master key (401)", async () => {
      const res = await request(app)
        .get("/api/ghl/status/locations")
        .set("x-master-api-key", "wrong-key");
      expect(res.status).toBe(401);
      expect(status.listLocationStatuses).not.toHaveBeenCalled();
    });

    it("accepts the key via the x-api-key header too", async () => {
      status.listLocationStatuses.mockResolvedValue([]);
      const res = await request(app)
        .get("/api/ghl/status/locations")
        .set("x-api-key", FAKE_MASTER_KEY);
      expect(res.status).toBe(200);
    });
  });

  describe("GET /locations", () => {
    it("returns the overview list", async () => {
      status.listLocationStatuses.mockResolvedValue([summary()]);
      const res = await auth(request(app).get("/api/ghl/status/locations"));
      expect(res.status).toBe(200);
      expect(res.body.locations).toHaveLength(1);
      expect(res.body.locations[0].connection.locationId).toBe("loc_1");
      // No credential ever leaves the endpoint.
      expect(JSON.stringify(res.body)).not.toContain("api_key");
    });

    it("returns 500 when the service throws", async () => {
      status.listLocationStatuses.mockRejectedValue(new Error("db down"));
      const res = await auth(request(app).get("/api/ghl/status/locations"));
      expect(res.status).toBe(500);
    });
  });

  describe("GET /locations/:locationId", () => {
    it("returns full detail for a known location", async () => {
      status.getLocationStatus.mockResolvedValue(detail());
      const res = await auth(request(app).get("/api/ghl/status/locations/loc_1"));
      expect(res.status).toBe(200);
      expect(res.body.connection.locationId).toBe("loc_1");
      expect(status.getLocationStatus).toHaveBeenCalledWith("loc_1");
    });

    it("returns 404 for an unknown location", async () => {
      status.getLocationStatus.mockResolvedValue(null);
      const res = await auth(request(app).get("/api/ghl/status/locations/nope"));
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: "unknown location" });
    });
  });
});
