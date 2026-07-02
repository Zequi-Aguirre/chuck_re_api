import { createHmac } from "crypto";
import express, { Express } from "express";
import request from "supertest";
import { mock, MockProxy } from "jest-mock-extended";
import { GhlEnrichmentConfig } from "../../config/GhlEnrichmentConfig";
import { GhlConnectionService } from "../../connections/GhlConnectionService";
import { GhlConnection } from "../../connections/GhlConnectionTypes";
import { LeadEnrichmentQueueService } from "../../../services/LeadEnrichmentQueueService";
import { GhlEnrichmentWebhookResource } from "../GhlEnrichmentWebhookResource";
import { GhlWebhookVerifier } from "../GhlWebhookVerifier";

// Obviously-fake, generated-looking secret. NOT a real credential.
const FAKE_SECRET = "whsec_fake_unit_test_secret_0000000000";

const sign = (rawBody: string): string =>
  createHmac("sha256", FAKE_SECRET).update(rawBody).digest("hex");

const connection = (over: Partial<GhlConnection> = {}): GhlConnection => ({
  id: "11111111-1111-1111-1111-111111111111",
  locationId: "loc_1",
  apiKey: "unit-test-plaintext-key",
  baseUrl: "https://services.leadconnectorhq.com",
  phoneNumbers: [],
  status: "active",
  createdAt: new Date("2026-07-01T00:00:00Z"),
  updatedAt: new Date("2026-07-01T00:00:00Z"),
  ...over,
});

describe("GhlEnrichmentWebhookResource", () => {
  let connections: MockProxy<GhlConnectionService>;
  let queue: MockProxy<LeadEnrichmentQueueService>;
  let app: Express;

  beforeEach(() => {
    connections = mock<GhlConnectionService>();
    queue = mock<LeadEnrichmentQueueService>();

    // Real verifier with an off-prod fake-secret config so signatures verify for real.
    const verifier = new GhlWebhookVerifier({
      webhookSecret: FAKE_SECRET,
      isProduction: false,
    } as unknown as GhlEnrichmentConfig);

    connections.getByLocationId.mockResolvedValue(connection());
    queue.enqueue.mockResolvedValue({ id: "ghl:loc_1:ct_1" } as never);

    const resource = new GhlEnrichmentWebhookResource(verifier, connections, queue);
    app = express();
    app.use("/webhooks/ghl", resource.router);
  });

  /** POST a signed JSON body to the receiver. */
  const post = (bodyObj: unknown, signature?: string) => {
    const raw = JSON.stringify(bodyObj);
    const req = request(app)
      .post("/webhooks/ghl")
      .set("Content-Type", "application/json");
    if (signature !== undefined) req.set("x-wh-signature", signature);
    return req.send(raw);
  };

  it("enqueues an enrichment job for a valid signed ContactCreate", async () => {
    const body = {
      type: "ContactCreate",
      locationId: "loc_1",
      id: "ct_1",
      address1: "742 Evergreen Terrace",
      city: "Springfield",
      state: "IL",
      postalCode: "62704",
    };

    const res = await post(body, sign(JSON.stringify(body)));

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ status: "queued", jobId: "ghl:loc_1:ct_1" });
    expect(queue.enqueue).toHaveBeenCalledTimes(1);
    expect(queue.enqueue).toHaveBeenCalledWith(
      {
        contact_id: "ct_1",
        location_id: "loc_1",
        full_address: "742 Evergreen Terrace, Springfield, IL, 62704",
      },
      { jobId: "ghl:loc_1:ct_1" }
    );
  });

  it("omits full_address when the payload carries no address", async () => {
    const body = { type: "ContactCreate", locationId: "loc_1", id: "ct_1" };

    await post(body, sign(JSON.stringify(body)));

    expect(queue.enqueue).toHaveBeenCalledWith(
      { contact_id: "ct_1", location_id: "loc_1" },
      { jobId: "ghl:loc_1:ct_1" }
    );
  });

  it("derives the same job id for a duplicate delivery (idempotent enqueue)", async () => {
    const body = { type: "ContactCreate", locationId: "loc_1", id: "ct_1" };
    const sig = sign(JSON.stringify(body));

    await post(body, sig);
    await post(body, sig);

    // Both deliveries target the SAME job id — BullMQ collapses them onto one job.
    const jobIds = queue.enqueue.mock.calls.map(([, opts]) => opts?.jobId);
    expect(jobIds).toEqual(["ghl:loc_1:ct_1", "ghl:loc_1:ct_1"]);
  });

  it("accepts the alternate id/casing variants GHL uses", async () => {
    const body = { type: "ContactCreate", location_id: "loc_1", contactId: "ct_9" };

    const res = await post(body, sign(JSON.stringify(body)));

    expect(res.status).toBe(202);
    expect(queue.enqueue).toHaveBeenCalledWith(
      { contact_id: "ct_9", location_id: "loc_1" },
      { jobId: "ghl:loc_1:ct_9" }
    );
  });

  it("rejects an invalid signature with 401 and does not enqueue", async () => {
    const body = { type: "ContactCreate", locationId: "loc_1", id: "ct_1" };

    const res = await post(body, sign("a different body"));

    expect(res.status).toBe(401);
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it("rejects a missing signature with 401", async () => {
    const body = { type: "ContactCreate", locationId: "loc_1", id: "ct_1" };

    const res = await post(body); // no signature header

    expect(res.status).toBe(401);
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it("returns 400 when the payload lacks a location or contact id", async () => {
    const body = { type: "ContactCreate", id: "ct_1" }; // no location

    const res = await post(body, sign(JSON.stringify(body)));

    expect(res.status).toBe(400);
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it("ignores non-ContactCreate events (ContactUpdate is off for MVP)", async () => {
    const body = { type: "ContactUpdate", locationId: "loc_1", id: "ct_1" };

    const res = await post(body, sign(JSON.stringify(body)));

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ignored");
    expect(queue.enqueue).not.toHaveBeenCalled();
    // Unknown location was never even consulted — event dropped first.
    expect(connections.getByLocationId).not.toHaveBeenCalled();
  });

  it("ignores webhooks for an unknown location", async () => {
    connections.getByLocationId.mockResolvedValue(null);
    const body = { type: "ContactCreate", locationId: "loc_unknown", id: "ct_1" };

    const res = await post(body, sign(JSON.stringify(body)));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ignored", reason: "unknown location" });
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it("ignores webhooks for an inactive (uninstalled) location", async () => {
    connections.getByLocationId.mockResolvedValue(connection({ status: "inactive" }));
    const body = { type: "ContactCreate", locationId: "loc_1", id: "ct_1" };

    const res = await post(body, sign(JSON.stringify(body)));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ignored", reason: "location inactive" });
    expect(queue.enqueue).not.toHaveBeenCalled();
  });
});
