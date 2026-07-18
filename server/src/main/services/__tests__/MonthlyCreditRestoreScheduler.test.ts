/**
 * JAK-197 — MonthlyCreditRestoreScheduler unit tests.
 *
 * The sweep runs on a plain in-process setInterval (NO BullMQ/Redis). These prove:
 *   - start() runs an immediate sweep and is idempotent;
 *   - a sweep never overlaps itself;
 *   - a throwing sweep is swallowed (the next tick recovers);
 *   - stop() halts the timer.
 * MonthlyCreditRestoreService is mocked — no DB.
 */
import { mock, MockProxy } from "jest-mock-extended";
import { EnvConfig } from "../../config/envConfig";
import { MonthlyCreditRestoreService } from "../../ghlEnrichment/metering/MonthlyCreditRestoreService";
import { MonthlyCreditRestoreScheduler } from "../MonthlyCreditRestoreScheduler";

const flush = () => new Promise<void>((r) => setImmediate(r));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

const env = (intervalMs = 3_600_000): EnvConfig =>
  ({ monthlyRestoreIntervalMs: intervalMs } as unknown as EnvConfig);

describe("MonthlyCreditRestoreScheduler", () => {
  let restore: MockProxy<MonthlyCreditRestoreService>;

  beforeEach(() => {
    jest.spyOn(console, "log").mockImplementation(() => undefined);
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    restore = mock<MonthlyCreditRestoreService>();
    restore.restoreDue.mockResolvedValue({ restored: 0, accountIds: [] });
  });
  afterEach(() => jest.restoreAllMocks());

  it("runs an immediate sweep on start()", async () => {
    const scheduler = new MonthlyCreditRestoreScheduler(env(), restore);
    scheduler.start();
    await flush();
    expect(restore.restoreDue).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });

  it("is idempotent — a second start() does not start a second timer/sweep", async () => {
    const scheduler = new MonthlyCreditRestoreScheduler(env(), restore);
    scheduler.start();
    scheduler.start();
    await flush();
    expect(restore.restoreDue).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });

  it("does not overlap: a sweep started while one is running is skipped", async () => {
    const scheduler = new MonthlyCreditRestoreScheduler(env(), restore);
    const gate = deferred();
    restore.restoreDue.mockImplementationOnce(async () => {
      await gate.promise;
      return { restored: 0, accountIds: [] };
    });

    const first = scheduler.sweep(); // starts, blocks on the gate
    await flush();
    await scheduler.sweep(); // should no-op while the first is in flight
    expect(restore.restoreDue).toHaveBeenCalledTimes(1);

    gate.resolve();
    await first;

    // Once the first completes, a later sweep runs again.
    await scheduler.sweep();
    expect(restore.restoreDue).toHaveBeenCalledTimes(2);
  });

  it("swallows a failing sweep (never throws) and recovers on the next call", async () => {
    const scheduler = new MonthlyCreditRestoreScheduler(env(), restore);
    restore.restoreDue.mockRejectedValueOnce(new Error("db down"));

    await expect(scheduler.sweep()).resolves.toBeUndefined();

    restore.restoreDue.mockResolvedValueOnce({ restored: 1, accountIds: ["c1"] });
    await scheduler.sweep();
    expect(restore.restoreDue).toHaveBeenCalledTimes(2);
  });

  it("fires again on the interval, and stop() halts it", async () => {
    jest.useFakeTimers();
    // Flush pending microtasks so each sweep finishes (running → false) before the
    // next tick — otherwise the overlap guard would (correctly) skip a still-running
    // sweep and make the count timing-dependent.
    const settle = async () => {
      for (let i = 0; i < 5; i++) await Promise.resolve();
    };
    try {
      const scheduler = new MonthlyCreditRestoreScheduler(env(1000), restore);
      scheduler.start(); // immediate sweep (1) + interval
      await settle();
      jest.advanceTimersByTime(1000); // → sweep (2)
      await settle();
      jest.advanceTimersByTime(1000); // → sweep (3)
      await settle();
      expect(restore.restoreDue).toHaveBeenCalledTimes(3);

      scheduler.stop();
      jest.advanceTimersByTime(5000); // no further sweeps after stop
      await settle();
      expect(restore.restoreDue).toHaveBeenCalledTimes(3);
    } finally {
      jest.useRealTimers();
    }
  });
});
