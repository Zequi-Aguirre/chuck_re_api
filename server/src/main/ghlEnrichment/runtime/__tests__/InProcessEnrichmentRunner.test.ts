/**
 * JAK-197 — InProcessEnrichmentRunner unit tests.
 *
 * Proves the runner reproduces the guardrails the always-on BullMQ workers gave us,
 * with NO Redis and NO idle polling: bounded concurrency, transient retry with a
 * permanent-error short-circuit, the dead-letter (onExhausted) hook, and dedupe.
 * `delay` is overridden so retries run without real timers.
 */
import { UnrecoverableError } from "bullmq";
import { EnvConfig } from "../../../config/envConfig";
import { InProcessEnrichmentRunner } from "../InProcessEnrichmentRunner";

/** A runner whose backoff is instant, so retry tests don't wait on real timers. */
class InstantRunner extends InProcessEnrichmentRunner {
  protected delay(): Promise<void> {
    return Promise.resolve();
  }
}

const env = (over: Partial<EnvConfig> = {}): EnvConfig =>
  ({
    autoEnrichConcurrency: 5,
    autoEnrichMaxAttempts: 3,
    autoEnrichBackoffMs: 10,
    ...over,
  } as unknown as EnvConfig);

/** Resolve after all currently-queued microtasks/immediates flush. */
const flush = () => new Promise<void>((r) => setImmediate(r));
/** Spin until the runner drains (bounded so a hang fails loudly instead of forever). */
async function untilIdle(runner: InProcessEnrichmentRunner): Promise<void> {
  for (let i = 0; i < 500 && runner.busy; i++) await flush();
}
/** A promise + its resolver, to gate a task "running" until we release it. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

describe("InProcessEnrichmentRunner", () => {
  beforeEach(() => {
    jest.spyOn(console, "log").mockImplementation(() => undefined);
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
    jest.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it("runs a submitted task exactly once on success", async () => {
    const runner = new InstantRunner(env());
    const run = jest.fn().mockResolvedValue("ok");

    expect(runner.submit({ label: "t", run })).toBe(true);
    await untilIdle(runner);

    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(1); // 1-based attempt number
    expect(runner.busy).toBe(false);
  });

  it("retries a transient (thrown) failure with backoff, then succeeds", async () => {
    const runner = new InstantRunner(env({ autoEnrichMaxAttempts: 3 }));
    const run = jest
      .fn()
      .mockRejectedValueOnce(new Error("429 transient"))
      .mockResolvedValueOnce("ok");
    const onExhausted = jest.fn();

    runner.submit({ label: "t", run, onExhausted });
    await untilIdle(runner);

    expect(run).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenNthCalledWith(1, 1);
    expect(run).toHaveBeenNthCalledWith(2, 2);
    expect(onExhausted).not.toHaveBeenCalled();
  });

  it("gives up after maxAttempts and runs the onExhausted dead-letter hook", async () => {
    const runner = new InstantRunner(env({ autoEnrichMaxAttempts: 2 }));
    const boom = new Error("still failing");
    const run = jest.fn().mockRejectedValue(boom);
    const onExhausted = jest.fn().mockResolvedValue(undefined);

    runner.submit({ label: "t", run, onExhausted });
    await untilIdle(runner);

    expect(run).toHaveBeenCalledTimes(2); // no more than maxAttempts
    expect(onExhausted).toHaveBeenCalledTimes(1);
    expect(onExhausted).toHaveBeenCalledWith(boom);
  });

  it("stops immediately (no retries) on an UnrecoverableError", async () => {
    const runner = new InstantRunner(env({ autoEnrichMaxAttempts: 5 }));
    const run = jest.fn().mockRejectedValue(new UnrecoverableError("permanent"));
    const onExhausted = jest.fn();

    runner.submit({ label: "t", run, onExhausted });
    await untilIdle(runner);

    expect(run).toHaveBeenCalledTimes(1); // permanent → no retry
    expect(onExhausted).toHaveBeenCalledTimes(1);
  });

  it("swallows an onExhausted hook error (one failure never cascades)", async () => {
    const runner = new InstantRunner(env({ autoEnrichMaxAttempts: 1 }));
    const run = jest.fn().mockRejectedValue(new Error("fail"));
    const onExhausted = jest.fn().mockRejectedValue(new Error("hook blew up"));

    runner.submit({ label: "t", run, onExhausted });
    await expect(untilIdle(runner)).resolves.toBeUndefined();
    expect(onExhausted).toHaveBeenCalledTimes(1);
    expect(runner.busy).toBe(false);
  });

  it("never runs more than the concurrency cap at once", async () => {
    const runner = new InstantRunner(env({ autoEnrichConcurrency: 2, autoEnrichMaxAttempts: 1 }));
    let running = 0;
    let peak = 0;
    const gates = [deferred(), deferred(), deferred(), deferred()];

    gates.forEach((gate, i) =>
      runner.submit({
        label: `t${i}`,
        run: async () => {
          running++;
          peak = Math.max(peak, running);
          await gate.promise;
          running--;
        },
      })
    );

    await flush();
    expect(running).toBe(2); // only 2 started; the other 2 wait for a slot

    gates.forEach((g) => g.resolve());
    await untilIdle(runner);

    expect(peak).toBe(2);
    expect(runner.busy).toBe(false);
  });

  it("dedupes a re-submitted key while the first is in flight", async () => {
    const runner = new InstantRunner(env({ autoEnrichConcurrency: 1, autoEnrichMaxAttempts: 1 }));
    const gate = deferred();
    const run = jest.fn(async () => {
      await gate.promise;
    });

    const first = runner.submit({ label: "a", dedupeKey: "contact_1", run });
    const second = runner.submit({ label: "a-dup", dedupeKey: "contact_1", run });

    expect(first).toBe(true);
    expect(second).toBe(false); // dropped as a duplicate
    await flush();
    expect(run).toHaveBeenCalledTimes(1);

    gate.resolve();
    await untilIdle(runner);

    // Once the in-flight one finishes, the key is free again for a later submit.
    expect(runner.submit({ label: "a-again", dedupeKey: "contact_1", run: jest.fn().mockResolvedValue(1) })).toBe(true);
    await untilIdle(runner);
  });

  it("is idle (not busy) with no submissions — no timers, no work", () => {
    const runner = new InstantRunner(env());
    expect(runner.busy).toBe(false);
  });
});
