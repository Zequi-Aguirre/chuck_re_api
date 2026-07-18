/**
 * JAK-106 + JAK-197 — GhlEnrichmentWebhookResource route tests.
 *
 * The worker is mocked (NO real REAPI/GHL); the runner is REAL and fire-and-forget:
 * the endpoint responds 202 first, then the runner synchronously invokes
 * worker.process(payload, { attempt }). JAK-197: enrichment runs IN-PROCESS — no
 * BullMQ/Redis — so we assert on worker.process, and the idempotency contract is the
 * shared dedupe key (location:contact) the runner collapses on.
 */
import { createHmac } from "crypto";
import express, { Express } from "express";
import request from "supertest";
import { mock, MockProxy } from "jest-mock-extended";
import { GhlEnrichmentConfig } from "../../config/GhlEnrichmentConfig";
import { GhlConnectionService } from "../../connections/GhlConnectionService";
import { GhlConnection } from "../../connections/GhlConnectionTypes";
import { EnvConfig } from "../../../config/envConfig";
import { InProcessEnrichmentRunner, EnrichmentTask } from "../../runtime/InProcessEnrichmentRunner";
import { GhlEnrichmentWorker } from "../../worker/GhlEnrichmentWorker";
import { GhlEnrichmentWebhookResource } from "../GhlEnrichmentWebhookResource";
import { GhlWebhookVerifier } from "../GhlWebhookVerifier";

// Obviously-fake, generated-looking secret. NOT a real credential.
const FAKE_SECRET = "whsec_fake_unit_test_secret_0000000000";

const sign = (rawBody: string): string =>
  createHmac("sha256", FAKE_SECRET).update(rawBody).digest("hex");

const connection = (over: Partial<GhlConnection> = {}): GhlConnection => ({
  id: "11111111-1111-1111-1111-111111111111",
  locationId: "loc_1",
  name: null,
  apiKey: "unit-test-plaintext-key",
  baseUrl: "https://services.leadconnectorhq.com",
  phoneNumbers: [],
  status: "active",
  autoEnrichmentEnabled: false,
  unlimitedCredits: false,
  createdAt: new Date("2026-07-01T00:00:00Z"),
  updatedAt: new Date("2026-07-01T00:00:00Z"),
  ...over,
});

describe("GhlEnrichmentWebhookResource", () => {
  let connections: MockProxy<GhlConnectionService>;
  let worker: MockProxy<GhlEnrichmentWorker>;
  let runner: InProcessEnrichmentRunner;
  let app: Express;

  beforeEach(() => {
    jest.spyOn(console, "log").mockImplementation(() => undefined);
    jest.spyOn(console, "warn").mockImplementation(() => undefined);

    connections = mock<GhlConnectionService>();
    worker = mock<GhlEnrichmentWorker>();
    worker.process.mockResolvedValue({ status: "enriched" } as never);

    // Real verifier with an off-prod fake-secret config so signatures verify for real.
    const verifier = new GhlWebhookVerifier({
      webhookSecret: FAKE_SECRET,
      isProduction: false,
    } as unknown as GhlEnrichmentConfig);

    connections.getByLocationId.mockResolvedValue(connection());

    const env = {
      autoEnrichConcurrency: 5,
      autoEnrichMaxAttempts: 3,
      autoEnrichBackoffMs: 2000,
    } as unknown as EnvConfig;
    runner = new InProcessEnrichmentRunner(env);

    const resource = new GhlEnrichmentWebhookResource(verifier, connections, runner, worker);
    app = express();
    app.use("/webhooks/ghl", resource.router);
  });

  afterEach(() => jest.restoreAllMocks());

  /** POST a signed JSON body to the receiver. */
  const post = (bodyObj: unknown, signature?: string) => {
    const raw = JSON.stringify(bodyObj);
    const req = request(app)
      .post("/webhooks/ghl")
      .set("Content-Type", "application/json");
    if (signature !== undefined) req.set("x-wh-signature", signature);
    return req.send(raw);
  };

  it("runs an enrichment job for a valid signed ContactCreate", async () => {
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
    expect(worker.process).toHaveBeenCalledTimes(1);
    expect(worker.process).toHaveBeenCalledWith(
      {
        contact_id: "ct_1",
        location_id: "loc_1",
        full_address: "742 Evergreen Terrace, Springfield, IL, 62704",
      },
      { attempt: 1 }
    );
  });

  it("omits full_address when the payload carries no address", async () => {
    const body = { type: "ContactCreate", locationId: "loc_1", id: "ct_1" };

    await post(body, sign(JSON.stringify(body)));

    expect(worker.process).toHaveBeenCalledWith(
      { contact_id: "ct_1", location_id: "loc_1" },
      { attempt: 1 }
    );
  });

  it("derives the same dedupe key for a duplicate delivery (idempotent handoff)", async () => {
    // Capture the submitted tasks WITHOUT running them, to inspect the dedupe key.
    const tasks: EnrichmentTask[] = [];
    jest.spyOn(runner, "submit").mockImplementation((task) => {
      tasks.push(task);
      return true;
    });
    const body = { type: "ContactCreate", locationId: "loc_1", id: "ct_1" };
    const sig = sign(JSON.stringify(body));

    await post(body, sig);
    await post(body, sig);

    // Both deliveries carry the SAME dedupe key — the runner collapses concurrent ones.
    expect(tasks.map((t) => t.dedupeKey)).toEqual(["ghl:loc_1:ct_1", "ghl:loc_1:ct_1"]);
  });

  it("accepts the alternate id/casing variants GHL uses", async () => {
    const body = { type: "ContactCreate", location_id: "loc_1", contactId: "ct_9" };

    const res = await post(body, sign(JSON.stringify(body)));

    expect(res.status).toBe(202);
    expect(worker.process).toHaveBeenCalledWith(
      { contact_id: "ct_9", location_id: "loc_1" },
      { attempt: 1 }
    );
  });

  it("rejects an invalid signature with 401 and does not run enrichment", async () => {
    const body = { type: "ContactCreate", locationId: "loc_1", id: "ct_1" };

    const res = await post(body, sign("a different body"));

    expect(res.status).toBe(401);
    expect(worker.process).not.toHaveBeenCalled();
  });

  it("rejects a missing signature with 401", async () => {
    const body = { type: "ContactCreate", locationId: "loc_1", id: "ct_1" };

    const res = await post(body); // no signature header

    expect(res.status).toBe(401);
    expect(worker.process).not.toHaveBeenCalled();
  });

  it("returns 400 when the payload lacks a location or contact id", async () => {
    const body = { type: "ContactCreate", id: "ct_1" }; // no location

    const res = await post(body, sign(JSON.stringify(body)));

    expect(res.status).toBe(400);
    expect(worker.process).not.toHaveBeenCalled();
  });

  it("ignores non-ContactCreate events (ContactUpdate is off for MVP)", async () => {
    const body = { type: "ContactUpdate", locationId: "loc_1", id: "ct_1" };

    const res = await post(body, sign(JSON.stringify(body)));

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ignored");
    expect(worker.process).not.toHaveBeenCalled();
    // Unknown location was never even consulted — event dropped first.
    expect(connections.getByLocationId).not.toHaveBeenCalled();
  });

  it("ignores webhooks for an unknown location", async () => {
    connections.getByLocationId.mockResolvedValue(null);
    const body = { type: "ContactCreate", locationId: "loc_unknown", id: "ct_1" };

    const res = await post(body, sign(JSON.stringify(body)));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ignored", reason: "unknown location" });
    expect(worker.process).not.toHaveBeenCalled();
  });

  it("ignores webhooks for an inactive (uninstalled) location", async () => {
    connections.getByLocationId.mockResolvedValue(connection({ status: "inactive" }));
    const body = { type: "ContactCreate", locationId: "loc_1", id: "ct_1" };

    const res = await post(body, sign(JSON.stringify(body)));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ignored", reason: "location inactive" });
    expect(worker.process).not.toHaveBeenCalled();
  });
});
