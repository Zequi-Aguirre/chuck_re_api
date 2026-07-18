/**
 * JAK-197 — regression guard: the enrichment path must NEVER start a BullMQ worker
 * or open a Redis connection.
 *
 * The whole point of this ticket is that idle Redis requests drop to ~0: enrichment
 * is webhook-triggered and runs IN-PROCESS, with no always-on consumer polling Redis
 * (the old design burned ~500k Upstash requests/day at zero volume). This test makes
 * that structural: it mocks `bullmq` and `ioredis` so that CONSTRUCTING a Worker,
 * Queue, QueueEvents, or ioredis client throws — then wires + exercises the real
 * enrichment path and asserts none of them were ever constructed.
 *
 * If a future change reintroduces a BullMQ worker (or any Redis client) on the
 * enrichment/scheduler path, this test fails loudly.
 */

// A guard factory: any attempt to construct this BullMQ/Redis primitive throws.
const forbid = (what: string) =>
  jest.fn(() => {
    throw new Error(`JAK-197 regression: ${what} was constructed — idle Redis polling reintroduced`);
  });

jest.mock("bullmq", () => ({
  Worker: forbid("BullMQ Worker"),
  Queue: forbid("BullMQ Queue"),
  QueueEvents: forbid("BullMQ QueueEvents"),
  // The processors legitimately use UnrecoverableError as a value — keep it a real class.
  UnrecoverableError: class UnrecoverableError extends Error {},
}));

jest.mock("ioredis", () => forbid("ioredis client"));

import express, { Express } from "express";
import request from "supertest";
import { mock } from "jest-mock-extended";
import * as bullmq from "bullmq";
import IORedis from "ioredis";
import { EnvConfig } from "../../../config/envConfig";
import { GhlConnectionService } from "../../connections/GhlConnectionService";
import { GhlConnection } from "../../connections/GhlConnectionTypes";
import { AutoEnrichmentWorker } from "../../autoEnrichment/AutoEnrichmentWorker";
import { ContactCreatedResource } from "../../autoEnrichment/ContactCreatedResource";
import { MonthlyCreditRestoreService } from "../../metering/MonthlyCreditRestoreService";
import { MonthlyCreditRestoreScheduler } from "../../../services/MonthlyCreditRestoreScheduler";
import { InProcessEnrichmentRunner } from "../InProcessEnrichmentRunner";

const FAKE_MASTER_KEY = "test-master-api-key-noidle-0000";
const flush = () => new Promise<void>((r) => setImmediate(r));

const connection = (): GhlConnection => ({
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
});

const env = (): EnvConfig =>
  ({
    masterApiKey: FAKE_MASTER_KEY,
    autoEnrichConcurrency: 5,
    autoEnrichMaxAttempts: 3,
    autoEnrichBackoffMs: 2000,
    monthlyRestoreIntervalMs: 3_600_000,
  } as unknown as EnvConfig);

describe("JAK-197 — no idle Redis polling on the enrichment path", () => {
  beforeEach(() => {
    jest.spyOn(console, "log").mockImplementation(() => undefined);
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
    (bullmq.Worker as unknown as jest.Mock).mockClear();
    (bullmq.Queue as unknown as jest.Mock).mockClear();
    (IORedis as unknown as jest.Mock).mockClear();
  });
  afterEach(() => jest.restoreAllMocks());

  it("wiring + driving the runner constructs NO BullMQ worker/queue and NO Redis client", async () => {
    const runner = new InProcessEnrichmentRunner(env());

    // Drive a real task end-to-end through the runner.
    const run = jest.fn().mockResolvedValue("ok");
    runner.submit({ label: "probe", run });
    await flush();

    expect(run).toHaveBeenCalledTimes(1);
    expect(runner.busy).toBe(false); // drained — nothing left polling
    expect(bullmq.Worker).not.toHaveBeenCalled();
    expect(bullmq.Queue).not.toHaveBeenCalled();
    expect(bullmq.QueueEvents).not.toHaveBeenCalled();
    expect(IORedis).not.toHaveBeenCalled();
  });

  it("the contact-created webhook enriches in-process — no worker/queue/Redis started", async () => {
    const connections = mock<GhlConnectionService>();
    connections.getByLocationId.mockResolvedValue(connection());
    const worker = mock<AutoEnrichmentWorker>();
    worker.process.mockResolvedValue({ status: "enriched" } as never);

    const runner = new InProcessEnrichmentRunner(env());
    const resource = new ContactCreatedResource(env(), connections, runner, worker);

    const app: Express = express();
    app.use(express.json());
    app.use("/ghl", resource.router);

    const res = await request(app)
      .post("/ghl/contact-created")
      .set("x-master-api-key", FAKE_MASTER_KEY)
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ locationId: "loc_1", contactId: "c1", address1: "1 A St", city: "X", state: "TX", postalCode: "70000" }));

    expect(res.status).toBe(200);
    await flush();
    expect(worker.process).toHaveBeenCalledTimes(1); // ran in-process, not via a queue
    expect(bullmq.Worker).not.toHaveBeenCalled();
    expect(bullmq.Queue).not.toHaveBeenCalled();
    expect(IORedis).not.toHaveBeenCalled();
  });

  it("the monthly-restore scheduler uses a plain timer — no BullMQ/Redis", async () => {
    const restore = mock<MonthlyCreditRestoreService>();
    restore.restoreDue.mockResolvedValue({ restored: 0, accountIds: [] });

    const scheduler = new MonthlyCreditRestoreScheduler(env(), restore);
    scheduler.start();
    await flush();
    scheduler.stop();

    expect(restore.restoreDue).toHaveBeenCalled();
    expect(bullmq.Worker).not.toHaveBeenCalled();
    expect(bullmq.Queue).not.toHaveBeenCalled();
    expect(IORedis).not.toHaveBeenCalled();
  });
});
