/**
 * JAK-182 — ContactCreatedResource route tests.
 *
 * The queue + connection store are mocked — NO real Redis / GHL / REAPI. Covers:
 *   - auth (MASTER_API_KEY) gate
 *   - a valid payload enqueues (and normalizes GHL's flexible field names)
 *   - a missing/invalid payload is rejected (400)
 *   - an unknown / inactive location acks (200) WITHOUT enqueuing
 *   - responds fast, never enriching in-request
 */
import express, { Express } from "express";
import request from "supertest";
import { mock, MockProxy } from "jest-mock-extended";
import { EnvConfig } from "../../../config/envConfig";
import { GhlConnectionService } from "../../connections/GhlConnectionService";
import { GhlConnection } from "../../connections/GhlConnectionTypes";
import { AutoEnrichmentQueueService } from "../AutoEnrichmentQueueService";
import { ContactCreatedResource } from "../ContactCreatedResource";

// Obviously-fake app secret. NOT a real credential.
const FAKE_MASTER_KEY = "test-master-api-key-0000000000";

const connection = (over: Partial<GhlConnection> = {}): GhlConnection => ({
  id: "11111111-1111-1111-1111-111111111111",
  locationId: "loc_1",
  apiKey: "unit-test-plaintext-key",
  baseUrl: "https://services.leadconnectorhq.com",
  phoneNumbers: [],
  status: "active",
  // JAK-186: the default fixture is a fully enabled location so the enqueue-path
  // tests exercise the happy case; individual tests override this to gate.
  autoEnrichmentEnabled: true,
  createdAt: new Date("2026-07-01T00:00:00Z"),
  updatedAt: new Date("2026-07-01T00:00:00Z"),
  ...over,
});

describe("ContactCreatedResource", () => {
  let connections: MockProxy<GhlConnectionService>;
  let queue: MockProxy<AutoEnrichmentQueueService>;
  let app: Express;

  beforeEach(() => {
    connections = mock<GhlConnectionService>();
    queue = mock<AutoEnrichmentQueueService>();

    connections.getByLocationId.mockResolvedValue(connection());
    queue.enqueue.mockResolvedValue({ id: "contact_1" } as never);

    const env = { masterApiKey: FAKE_MASTER_KEY } as unknown as EnvConfig;
    const resource = new ContactCreatedResource(env, connections, queue);
    app = express();
    app.use(express.json());
    app.use("/ghl", resource.router);
  });

  /** POST a JSON body to the receiver, with the auth header unless told otherwise. */
  const post = (body: unknown, opts: { auth?: boolean; key?: string } = {}) => {
    const req = request(app).post("/ghl/contact-created").set("Content-Type", "application/json");
    if (opts.auth !== false) req.set("x-master-api-key", opts.key ?? FAKE_MASTER_KEY);
    return req.send(JSON.stringify(body));
  };

  const validBody = {
    locationId: "loc_1",
    contactId: "contact_1",
    address1: "742 Evergreen Terrace",
    city: "Springfield",
    state: "IL",
    postalCode: "62704",
  };

  describe("auth", () => {
    it("rejects a request with no MASTER_API_KEY header (401)", async () => {
      const res = await post(validBody, { auth: false });
      expect(res.status).toBe(401);
      expect(queue.enqueue).not.toHaveBeenCalled();
    });

    it("rejects a request with the wrong key (401)", async () => {
      const res = await post(validBody, { key: "wrong-key" });
      expect(res.status).toBe(401);
      expect(queue.enqueue).not.toHaveBeenCalled();
    });

    it("accepts the x-api-key header alias", async () => {
      const res = await request(app)
        .post("/ghl/contact-created")
        .set("x-api-key", FAKE_MASTER_KEY)
        .set("Content-Type", "application/json")
        .send(JSON.stringify(validBody));
      expect(res.status).toBe(200);
      expect(queue.enqueue).toHaveBeenCalledTimes(1);
    });
  });

  describe("valid payload → enqueue", () => {
    it("enqueues a normalized job and responds 200 fast", async () => {
      const res = await post(validBody);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: "queued", contactId: "contact_1" });
      expect(queue.enqueue).toHaveBeenCalledTimes(1);
      expect(queue.enqueue).toHaveBeenCalledWith({
        locationId: "loc_1",
        contactId: "contact_1",
        address: {
          line1: "742 Evergreen Terrace",
          city: "Springfield",
          state: "IL",
          postal: "62704",
        },
      });
    });

    it("tolerates snake_case + alias field names (location_id / id / zip / address)", async () => {
      const res = await post({
        location_id: "loc_1",
        id: "contact_9",
        address: "500 Main St",
        city: "Dallas",
        state: "TX",
        zip: "75001",
      });

      expect(res.status).toBe(200);
      expect(queue.enqueue).toHaveBeenCalledWith({
        locationId: "loc_1",
        contactId: "contact_9",
        address: { line1: "500 Main St", city: "Dallas", state: "TX", postal: "75001" },
      });
    });

    it("falls back to rawContact when no address parts are present", async () => {
      const body = { locationId: "loc_1", contactId: "contact_1", firstName: "Jane" };
      const res = await post(body);

      expect(res.status).toBe(200);
      expect(queue.enqueue).toHaveBeenCalledWith({
        locationId: "loc_1",
        contactId: "contact_1",
        rawContact: body,
      });
    });

    it("does not pass a jobId — queue owns dedupe (jobId = contactId)", async () => {
      await post(validBody);
      // enqueue called with a single arg (payload only), no opts overriding jobId.
      expect(queue.enqueue.mock.calls[0]).toHaveLength(1);
    });
  });

  describe("invalid payload → 400", () => {
    it("rejects a body missing contactId", async () => {
      const res = await post({ locationId: "loc_1", city: "Springfield" });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ status: "rejected", error: "missing locationId or contactId" });
      expect(queue.enqueue).not.toHaveBeenCalled();
    });

    it("rejects a body missing locationId", async () => {
      const res = await post({ contactId: "contact_1" });
      expect(res.status).toBe(400);
      expect(queue.enqueue).not.toHaveBeenCalled();
    });

    it("rejects an empty body", async () => {
      const res = await post({});
      expect(res.status).toBe(400);
      expect(queue.enqueue).not.toHaveBeenCalled();
    });

    it("rejects blank / whitespace-only ids", async () => {
      const res = await post({ locationId: "   ", contactId: "  " });
      expect(res.status).toBe(400);
      expect(queue.enqueue).not.toHaveBeenCalled();
    });

    it("never resolves the connection for an invalid payload", async () => {
      await post({ locationId: "loc_1" });
      expect(connections.getByLocationId).not.toHaveBeenCalled();
    });
  });

  describe("not-enabled location → 200 ack, no enqueue", () => {
    it("acks without enqueuing when the location has no connection", async () => {
      connections.getByLocationId.mockResolvedValue(null);
      const res = await post(validBody);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: "skipped", reason: "unknown location" });
      expect(queue.enqueue).not.toHaveBeenCalled();
    });

    it("acks without enqueuing when the connection is inactive", async () => {
      connections.getByLocationId.mockResolvedValue(connection({ status: "inactive" }));
      const res = await post(validBody);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: "skipped", reason: "enrichment not enabled" });
      expect(queue.enqueue).not.toHaveBeenCalled();
    });

    it("acks without enqueuing when the JAK-186 toggle is OFF (active but not enabled)", async () => {
      connections.getByLocationId.mockResolvedValue(
        connection({ status: "active", autoEnrichmentEnabled: false })
      );
      const res = await post(validBody);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: "skipped", reason: "enrichment not enabled" });
      expect(queue.enqueue).not.toHaveBeenCalled();
    });

    it("enqueues when the JAK-186 toggle is ON (active AND enabled)", async () => {
      connections.getByLocationId.mockResolvedValue(
        connection({ status: "active", autoEnrichmentEnabled: true })
      );
      const res = await post(validBody);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: "queued", contactId: "contact_1" });
      expect(queue.enqueue).toHaveBeenCalledTimes(1);
    });
  });

  describe("resilience", () => {
    it("returns 500 (not a crash) if the queue throws", async () => {
      queue.enqueue.mockRejectedValue(new Error("redis down"));
      const res = await post(validBody);
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ status: "error", error: "Internal Server Error" });
    });
  });
});
