/**
 * JAK-183 — end-to-end (fully mocked) pipeline test.
 *
 * Exercises the whole chain with NO real Redis / REAPI / GHL:
 *   POST /ghl/contact-created  →  AutoEnrichmentQueueService.enqueue()
 *     →  (drain the captured job)  →  AutoEnrichmentWorker.process()
 *       →  REAPI DAO (mock)  →  JAK-184 formatter  →  writeEnrichmentFields (mock)
 *
 * BullMQ is stubbed so `enqueue` hands us the job payload, which we feed straight
 * into the real worker — proving the endpoint's payload shape is exactly what the
 * worker consumes (the JAK-182 ↔ JAK-181 ↔ JAK-183 contract holds).
 */
import express, { Express } from "express";
import request from "supertest";
import { mock, MockProxy } from "jest-mock-extended";
import { EnvConfig } from "../../../config/envConfig";
import { GhlConnectionService } from "../../connections/GhlConnectionService";
import { GhlConnection } from "../../connections/GhlConnectionTypes";
import { RedisContainer } from "../../../config/RedisContainer";
import { AutoEnrichmentQueueService } from "../AutoEnrichmentQueueService";
import { AutoEnrichmentWorker } from "../AutoEnrichmentWorker";
import { ContactCreatedResource } from "../ContactCreatedResource";
import { AutoEnrichmentJobPayload } from "../AutoEnrichmentQueueTypes";
import { RealEstateApiDao } from "../../../data/RealEstateApiDao";
import { EnrichmentFieldWriteBackService } from "../EnrichmentFieldWriteBackService";
import { RealEstateApiPropertyDetail } from "../../../types/RealEstateApi";

// Capture what the producer enqueues; Worker is unused in this chain.
const enqueuedJobs: AutoEnrichmentJobPayload[] = [];
jest.mock("bullmq", () => ({
  Queue: jest.fn().mockImplementation(() => ({
    add: jest.fn(async (_name: string, data: AutoEnrichmentJobPayload) => {
      enqueuedJobs.push(data);
      return { id: data.contactId };
    }),
    close: jest.fn(),
  })),
  Worker: jest.fn(),
}));

const FAKE_MASTER_KEY = "test-master-api-key-e2e-0000";

const connection = (): GhlConnection => ({
  id: "11111111-1111-1111-1111-111111111111",
  locationId: "loc_1",
  name: null,
  apiKey: "unit-test-plaintext-key",
  baseUrl: "https://services.leadconnectorhq.com",
  phoneNumbers: [],
  status: "active",
  autoEnrichmentEnabled: true, // JAK-186: enabled so the pipeline runs end-to-end
  createdAt: new Date("2026-07-01T00:00:00Z"),
  updatedAt: new Date("2026-07-01T00:00:00Z"),
});

const subject = (): RealEstateApiPropertyDetail =>
  ({
    mlsActive: true,
    propertyType: "SFR",
    ownerInfo: { owner1FullName: "Jane Q. Homeowner" },
    propertyInfo: { address: { label: "742 Evergreen Terrace, Springfield, IL 62704" } },
  } as unknown as RealEstateApiPropertyDetail);

describe("auto-enrichment pipeline (endpoint → queue → worker → write)", () => {
  let connections: MockProxy<GhlConnectionService>;
  let realEstate: MockProxy<RealEstateApiDao>;
  let writeBack: MockProxy<EnrichmentFieldWriteBackService>;
  let queue: AutoEnrichmentQueueService;
  let processor: AutoEnrichmentWorker;
  let app: Express;

  beforeEach(() => {
    enqueuedJobs.length = 0;
    jest.spyOn(console, "log").mockImplementation(() => undefined);
    jest.spyOn(console, "warn").mockImplementation(() => undefined);

    const env = {
      masterApiKey: FAKE_MASTER_KEY,
      autoEnrichQueueName: "e2e-queue",
      autoEnrichConcurrency: 5,
      autoEnrichMaxAttempts: 3,
      autoEnrichBackoffMs: 2000,
    } as unknown as EnvConfig;
    const redis = { redis: { options: {} } } as unknown as RedisContainer;

    realEstate = mock<RealEstateApiDao>();
    writeBack = mock<EnrichmentFieldWriteBackService>();
    writeBack.writeEnrichmentFields.mockResolvedValue({
      written: ["MLS Status", "Property Type", "Owner of Record"],
      skipped: [],
      didWrite: true,
    });
    processor = new AutoEnrichmentWorker(realEstate, writeBack);

    // The real producer (BullMQ stubbed) + the real endpoint on top of it.
    queue = new AutoEnrichmentQueueService(env, redis, processor);
    connections = mock<GhlConnectionService>();
    connections.getByLocationId.mockResolvedValue(connection());
    const resource = new ContactCreatedResource(env, connections, queue);

    app = express();
    app.use(express.json());
    app.use("/ghl", resource.router);
  });

  afterEach(() => jest.restoreAllMocks());

  it("enqueues on POST, then the worker enriches the captured job end-to-end", async () => {
    realEstate.getPropertyDetailSubjectByAddress.mockResolvedValue(subject());

    // 1. GHL workflow POSTs a new contact.
    const res = await request(app)
      .post("/ghl/contact-created")
      .set("x-master-api-key", FAKE_MASTER_KEY)
      .set("Content-Type", "application/json")
      .send(
        JSON.stringify({
          locationId: "loc_1",
          contactId: "contact_1",
          address1: "742 Evergreen Terrace",
          city: "Springfield",
          state: "IL",
          postalCode: "62704",
        })
      );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "queued", contactId: "contact_1" });
    expect(enqueuedJobs).toHaveLength(1);

    // 2. Drain the captured job through the real worker.
    const outcome = await processor.process(enqueuedJobs[0]);

    // 3. The full chain resolved: REAPI → format → write-back.
    expect(realEstate.getPropertyDetailSubjectByAddress).toHaveBeenCalledWith(
      "742 Evergreen Terrace, Springfield, IL 62704"
    );
    const [locationId, contactId, fields] = writeBack.writeEnrichmentFields.mock.calls[0];
    expect(locationId).toBe("loc_1");
    expect(contactId).toBe("contact_1");
    expect(fields).toMatchObject({ mlsStatus: "Listed", propertyType: "SFR" });
    expect(outcome.status).toBe("enriched");
  });

  it("unknown location acks 200 without enqueuing — nothing reaches the worker", async () => {
    connections.getByLocationId.mockResolvedValue(null);

    const res = await request(app)
      .post("/ghl/contact-created")
      .set("x-master-api-key", FAKE_MASTER_KEY)
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ locationId: "loc_x", contactId: "contact_1", address1: "1 A St", city: "X", state: "TX", postalCode: "70000" }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "skipped", reason: "unknown location" });
    expect(enqueuedJobs).toHaveLength(0);
  });
});
