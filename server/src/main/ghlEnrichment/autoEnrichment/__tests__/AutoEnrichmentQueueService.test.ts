/**
 * JAK-181 — AutoEnrichmentQueueService unit tests.
 *
 * BullMQ is fully mocked: NO real Redis, REAPI, or GHL is touched. We assert the
 * queue is constructed with the right name/connection/retry policy and that
 * enqueue() dedupes by contactId — the three guardrails the ticket requires.
 */

// Capture the constructor args + the queue instance's methods. Names are
// `mock`-prefixed so Jest allows referencing them inside the hoisted factory.
const mockAdd = jest.fn();
const mockClose = jest.fn();
const mockQueueCtor = jest.fn();

jest.mock("bullmq", () => ({
  Queue: jest.fn().mockImplementation((name: string, opts: unknown) => {
    mockQueueCtor(name, opts);
    return { add: mockAdd, close: mockClose };
  }),
  // Worker must NOT be instantiated by this ticket (that's JAK-183).
  Worker: jest.fn(),
}));

import { Queue, Worker, JobsOptions } from "bullmq";
import { AutoEnrichmentQueueService } from "../AutoEnrichmentQueueService";
import { AutoEnrichmentJobPayload } from "../AutoEnrichmentQueueTypes";
import { AutoEnrichmentWorker } from "../AutoEnrichmentWorker";
import { EnvConfig } from "../../../config/envConfig";
import { RedisContainer } from "../../../config/RedisContainer";

/** A fake ioredis client shape — only `.options` is read by the service/worker. */
const fakeRedisContainer = (): RedisContainer =>
  ({ redis: { options: { host: "fake", port: 6379 } } } as unknown as RedisContainer);

/** A stub processor — the JAK-183 pipeline is tested in its own suite. */
const fakeProcessor = (): AutoEnrichmentWorker =>
  ({ process: jest.fn() } as unknown as AutoEnrichmentWorker);

/** A partial EnvConfig with just the auto-enrichment knobs the service reads. */
const fakeEnv = (overrides: Partial<EnvConfig> = {}): EnvConfig =>
  ({
    autoEnrichQueueName: "test-auto-enrichment",
    autoEnrichConcurrency: 5,
    autoEnrichMaxAttempts: 3,
    autoEnrichBackoffMs: 2000,
    ...overrides,
  } as unknown as EnvConfig);

const makeService = (env: EnvConfig = fakeEnv()) =>
  new AutoEnrichmentQueueService(env, fakeRedisContainer(), fakeProcessor());

const basePayload = (
  overrides: Partial<AutoEnrichmentJobPayload> = {}
): AutoEnrichmentJobPayload => ({
  locationId: "loc_123",
  contactId: "contact_abc",
  address: { line1: "123 Main St", city: "Austin", state: "TX", postal: "78701" },
  ...overrides,
});

beforeEach(() => {
  mockAdd.mockReset();
  mockClose.mockReset();
  mockQueueCtor.mockReset();
  (Queue as unknown as jest.Mock).mockClear();
  (Worker as unknown as jest.Mock).mockClear();
  mockAdd.mockResolvedValue({ id: "contact_abc" });
});

describe("AutoEnrichmentQueueService construction", () => {
  it("creates the queue with the env-configured name", () => {
    makeService(fakeEnv({ autoEnrichQueueName: "custom-queue" } as Partial<EnvConfig>));
    expect(mockQueueCtor).toHaveBeenCalledTimes(1);
    expect(mockQueueCtor.mock.calls[0][0]).toBe("custom-queue");
  });

  it("reuses the shared RedisContainer ioredis client (no new connection)", () => {
    const redis = fakeRedisContainer();
    new AutoEnrichmentQueueService(fakeEnv(), redis, fakeProcessor());
    const opts = mockQueueCtor.mock.calls[0][1] as { connection: unknown };
    expect(opts.connection).toBe((redis as unknown as { redis: unknown }).redis);
  });

  it("configures bounded exponential-backoff retries from env", () => {
    makeService(fakeEnv({ autoEnrichMaxAttempts: 4, autoEnrichBackoffMs: 1500 } as Partial<EnvConfig>));
    const opts = mockQueueCtor.mock.calls[0][1] as {
      defaultJobOptions: JobsOptions;
    };
    expect(opts.defaultJobOptions.attempts).toBe(4);
    expect(opts.defaultJobOptions.backoff).toEqual({ type: "exponential", delay: 1500 });
  });

  it("keeps failed jobs as a dead-letter and clears completed ones", () => {
    makeService();
    const opts = mockQueueCtor.mock.calls[0][1] as {
      defaultJobOptions: JobsOptions;
    };
    expect(opts.defaultJobOptions.removeOnComplete).toBe(true);
    expect(opts.defaultJobOptions.removeOnFail).toBe(false);
  });

  it("exposes the queue name and concurrency cap for JAK-183", () => {
    const svc = makeService(
      fakeEnv({ autoEnrichQueueName: "q", autoEnrichConcurrency: 8 } as Partial<EnvConfig>)
    );
    expect(svc.queueName).toBe("q");
    expect(svc.concurrency).toBe(8);
  });

  it("does NOT start a Worker (that is JAK-183)", () => {
    makeService();
    expect(Worker as unknown as jest.Mock).not.toHaveBeenCalled();
  });
});

describe("enqueue", () => {
  it("adds a job with the single job name and the payload", async () => {
    const svc = makeService();
    const payload = basePayload();
    await svc.enqueue(payload);

    expect(mockAdd).toHaveBeenCalledTimes(1);
    const [jobName, data] = mockAdd.mock.calls[0];
    expect(jobName).toBe(AutoEnrichmentQueueService.JOB_NAME);
    expect(data).toEqual(payload);
  });

  it("dedupes by using contactId as the BullMQ jobId", async () => {
    const svc = makeService();
    await svc.enqueue(basePayload({ contactId: "contact_xyz" }));

    const opts = mockAdd.mock.calls[0][2] as JobsOptions;
    expect(opts.jobId).toBe("contact_xyz");
  });

  it("never lets caller opts override the dedupe jobId", async () => {
    const svc = makeService();
    await svc.enqueue(basePayload({ contactId: "contact_real" }), {
      jobId: "attacker_supplied",
      priority: 7,
    });

    const opts = mockAdd.mock.calls[0][2] as JobsOptions;
    expect(opts.jobId).toBe("contact_real"); // contactId wins
    expect(opts.priority).toBe(7); // other opts pass through
  });

  it("supports a raw-contact payload (no parsed address)", async () => {
    const svc = makeService();
    const payload = basePayload({
      address: undefined,
      rawContact: { id: "contact_abc", address1: "9 Oak Ave", city: "Dallas" },
    });
    await svc.enqueue(payload);

    const [, data] = mockAdd.mock.calls[0];
    expect(data).toEqual(payload);
  });

  it("returns the job object from the queue (existing job on a dedupe hit)", async () => {
    mockAdd.mockResolvedValue({ id: "contact_abc" });
    const svc = makeService();
    const job = await svc.enqueue(basePayload());
    expect(job).toEqual({ id: "contact_abc" });
  });
});

describe("close", () => {
  it("closes the underlying queue", async () => {
    mockClose.mockResolvedValue(undefined);
    const svc = makeService();
    await svc.close();
    expect(mockClose).toHaveBeenCalledTimes(1);
  });
});
