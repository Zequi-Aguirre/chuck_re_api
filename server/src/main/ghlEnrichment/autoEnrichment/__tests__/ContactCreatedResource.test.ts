/**
 * JAK-182 + JAK-189 + JAK-197 — ContactCreatedResource route tests.
 *
 * The worker + connection service are mocked — NO real Redis / GHL / REAPI. The
 * runner is REAL but its work is fire-and-forget: the endpoint responds first, then
 * the runner synchronously invokes worker.process(payload), so we assert on that.
 * Covers:
 *   - per-location webhook-key auth (x-api-key): valid key → resolves the location;
 *     unknown / absent key → 401
 *   - body locationId mismatch vs the key's location → 401
 *   - missing contactId → 400; locationId OPTIONAL (the key identifies it)
 *   - active + toggle-on → submitted; inactive / toggle-off → skipped 200
 *   - MASTER_API_KEY internal override still resolves a location from the body
 *   - responds fast, never enriching in-request; JAK-197: no BullMQ/queue
 */
import express, { Express } from "express";
import request from "supertest";
import { mock, MockProxy } from "jest-mock-extended";
import { EnvConfig } from "../../../config/envConfig";
import { GhlConnectionService } from "../../connections/GhlConnectionService";
import { GhlConnection } from "../../connections/GhlConnectionTypes";
import { InProcessEnrichmentRunner } from "../../runtime/InProcessEnrichmentRunner";
import { AutoEnrichmentWorker } from "../AutoEnrichmentWorker";
import { ContactCreatedResource } from "../ContactCreatedResource";

// Obviously-fake, generated-looking values. NOT real credentials.
const FAKE_MASTER_KEY = "test-master-api-key-0000000000";
const FAKE_WEBHOOK_KEY = "jakewh_deadbeef00000000000000000000000000000000000000000000000000000000";

const connection = (over: Partial<GhlConnection> = {}): GhlConnection => ({
  id: "11111111-1111-1111-1111-111111111111",
  locationId: "loc_1",
  name: null,
  apiKey: "unit-test-plaintext-key",
  baseUrl: "https://services.leadconnectorhq.com",
  phoneNumbers: [],
  status: "active",
  autoEnrichmentEnabled: true,
  unlimitedCredits: false,
  createdAt: new Date("2026-07-01T00:00:00Z"),
  updatedAt: new Date("2026-07-01T00:00:00Z"),
  ...over,
});

describe("ContactCreatedResource", () => {
  let connections: MockProxy<GhlConnectionService>;
  let worker: MockProxy<AutoEnrichmentWorker>;
  let runner: InProcessEnrichmentRunner;
  let app: Express;

  beforeEach(() => {
    jest.spyOn(console, "log").mockImplementation(() => undefined);
    jest.spyOn(console, "warn").mockImplementation(() => undefined);

    connections = mock<GhlConnectionService>();
    worker = mock<AutoEnrichmentWorker>();
    worker.process.mockResolvedValue({ status: "enriched" } as never);

    // The webhook key resolves loc_1 by default; the master path resolves by id.
    connections.getByWebhookKey.mockResolvedValue(connection());
    connections.getByLocationId.mockResolvedValue(connection());

    const env = {
      masterApiKey: FAKE_MASTER_KEY,
      autoEnrichConcurrency: 5,
      autoEnrichMaxAttempts: 3,
      autoEnrichBackoffMs: 2000,
    } as unknown as EnvConfig;
    runner = new InProcessEnrichmentRunner(env);
    const resource = new ContactCreatedResource(env, connections, runner, worker);
    app = express();
    app.use(express.json());
    app.use("/ghl", resource.router);
  });

  afterEach(() => jest.restoreAllMocks());

  /** POST with the per-location webhook key in x-api-key (unless overridden). */
  const post = (body: unknown, opts: { auth?: boolean; key?: string; header?: string } = {}) => {
    const req = request(app).post("/ghl/contact-created").set("Content-Type", "application/json");
    if (opts.auth !== false) req.set(opts.header ?? "x-api-key", opts.key ?? FAKE_WEBHOOK_KEY);
    return req.send(JSON.stringify(body));
  };

  // The body no longer needs a locationId — the key identifies the location.
  const validBody = {
    contactId: "contact_1",
    address1: "742 Evergreen Terrace",
    city: "Springfield",
    state: "IL",
    postalCode: "62704",
  };

  describe("webhook-key auth", () => {
    it("rejects a request with NO key header (401)", async () => {
      const res = await post(validBody, { auth: false });
      expect(res.status).toBe(401);
      expect(worker.process).not.toHaveBeenCalled();
    });

    it("rejects a key no location owns (401)", async () => {
      connections.getByWebhookKey.mockResolvedValue(null);
      const res = await post(validBody, { key: "jakewh_unknownkey" });
      expect(res.status).toBe(401);
      expect(worker.process).not.toHaveBeenCalled();
    });

    it("resolves the location BY the presented key (never by body locationId)", async () => {
      await post(validBody);
      expect(connections.getByWebhookKey).toHaveBeenCalledWith(FAKE_WEBHOOK_KEY);
      expect(worker.process).toHaveBeenCalledTimes(1);
    });
  });

  describe("valid key → submit to runner", () => {
    it("runs enrichment with the KEY's location and responds 200 fast", async () => {
      const res = await post(validBody);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: "queued", contactId: "contact_1" });
      expect(worker.process).toHaveBeenCalledTimes(1);
      expect(worker.process).toHaveBeenCalledWith({
        locationId: "loc_1",
        contactId: "contact_1",
        address: { line1: "742 Evergreen Terrace", city: "Springfield", state: "IL", postal: "62704" },
      });
    });

    it("tolerates snake_case + alias field names (id / zip / address)", async () => {
      const res = await post({ id: "contact_9", address: "500 Main St", city: "Dallas", state: "TX", zip: "75001" });
      expect(res.status).toBe(200);
      expect(worker.process).toHaveBeenCalledWith({
        locationId: "loc_1",
        contactId: "contact_9",
        address: { line1: "500 Main St", city: "Dallas", state: "TX", postal: "75001" },
      });
    });

    it("falls back to rawContact when no address parts are present", async () => {
      const body = { contactId: "contact_1", firstName: "Jane" };
      const res = await post(body);
      expect(res.status).toBe(200);
      expect(worker.process).toHaveBeenCalledWith({
        locationId: "loc_1",
        contactId: "contact_1",
        rawContact: body,
      });
    });

    it("passes only the payload to the worker (runner owns dedupe by contactId)", async () => {
      await post(validBody);
      expect(worker.process.mock.calls[0]).toHaveLength(1);
    });
  });

  describe("body locationId cross-check", () => {
    it("submits when a body locationId MATCHES the key's location", async () => {
      const res = await post({ ...validBody, locationId: "loc_1" });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("queued");
    });

    it("rejects (401) when a body locationId does NOT match the key's location", async () => {
      const res = await post({ ...validBody, locationId: "loc_OTHER" });
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ status: "unauthorized", error: "location mismatch" });
      expect(worker.process).not.toHaveBeenCalled();
    });
  });

  describe("invalid payload → 400", () => {
    it("rejects a body missing contactId (400)", async () => {
      const res = await post({ city: "Springfield" });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ status: "rejected", error: "missing contactId" });
      expect(worker.process).not.toHaveBeenCalled();
    });

    it("rejects an empty body (400)", async () => {
      const res = await post({});
      expect(res.status).toBe(400);
      expect(worker.process).not.toHaveBeenCalled();
    });

    it("rejects a blank / whitespace-only contactId (400)", async () => {
      const res = await post({ contactId: "  " });
      expect(res.status).toBe(400);
      expect(worker.process).not.toHaveBeenCalled();
    });

    it("authenticates BEFORE validating — no key + bad body is still 401", async () => {
      const res = await post({}, { auth: false });
      expect(res.status).toBe(401);
    });
  });

  describe("not-enabled location → 200 ack, no submit", () => {
    it("acks without submitting when the connection is inactive", async () => {
      connections.getByWebhookKey.mockResolvedValue(connection({ status: "inactive" }));
      const res = await post(validBody);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: "skipped", reason: "enrichment not enabled" });
      expect(worker.process).not.toHaveBeenCalled();
    });

    it("acks without submitting when the JAK-186 toggle is OFF", async () => {
      connections.getByWebhookKey.mockResolvedValue(connection({ autoEnrichmentEnabled: false }));
      const res = await post(validBody);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: "skipped", reason: "enrichment not enabled" });
      expect(worker.process).not.toHaveBeenCalled();
    });

    it("submits when active AND toggle ON", async () => {
      connections.getByWebhookKey.mockResolvedValue(connection({ status: "active", autoEnrichmentEnabled: true }));
      const res = await post(validBody);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: "queued", contactId: "contact_1" });
      expect(worker.process).toHaveBeenCalledTimes(1);
    });
  });

  describe("MASTER_API_KEY internal override", () => {
    it("resolves the location from the body when the master key is presented", async () => {
      const res = await post({ locationId: "loc_1", contactId: "contact_1" }, {
        key: FAKE_MASTER_KEY,
        header: "x-master-api-key",
      });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("queued");
      expect(connections.getByLocationId).toHaveBeenCalledWith("loc_1");
      // The webhook-key lookup is NOT used on the master path.
      expect(connections.getByWebhookKey).not.toHaveBeenCalled();
    });

    it("401s when the master key is presented WITHOUT a body locationId", async () => {
      const res = await post({ contactId: "contact_1" }, { key: FAKE_MASTER_KEY, header: "x-master-api-key" });
      expect(res.status).toBe(401);
      expect(worker.process).not.toHaveBeenCalled();
    });

    it("acks 200 skipped when the master key targets an unknown location", async () => {
      connections.getByLocationId.mockResolvedValue(null);
      const res = await post({ locationId: "loc_missing", contactId: "contact_1" }, {
        key: FAKE_MASTER_KEY,
        header: "x-master-api-key",
      });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: "skipped", reason: "unknown location" });
    });
  });

  describe("resilience", () => {
    it("returns 500 (not a crash) if the handoff throws", async () => {
      jest.spyOn(runner, "submit").mockImplementation(() => {
        throw new Error("boom");
      });
      const res = await post(validBody);
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ status: "error", error: "Internal Server Error" });
    });
  });
});
