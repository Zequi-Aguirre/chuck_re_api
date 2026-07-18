import { injectable, inject } from "tsyringe";
import { EnvConfig } from "../config/envConfig.ts";
import { MonthlyCreditRestoreService } from "../ghlEnrichment/metering/MonthlyCreditRestoreService.ts";

/**
 * In-process scheduler for the monthly credit-RESTORE sweep (JAK-197, replacing the
 * JAK-072 BullMQ queue+worker).
 *
 * The old design ran a persistent BullMQ Worker + a repeatable cron job on Redis
 * purely to fire {@link MonthlyCreditRestoreService.restoreDue} ~once an hour. That
 * worker POLLED Redis 24/7 (a third of the ~500k/day Upstash blowout) to do work
 * that touches only Postgres. A sweep needs no queue and no Redis — just a timer.
 *
 * So this is a plain `setInterval`. Semantics are unchanged from the cron version:
 *   - the cadence is "how often we sweep", NOT "how often a customer is restored" —
 *     the per-customer atomic `next_reset_at` claim caps each customer at one
 *     restore per monthly cycle, so a sweep that finds nobody due is a cheap no-op;
 *   - one sweep never overlaps itself ({@link running} guard), matching the old
 *     `concurrency: 1`;
 *   - a firing that throws is logged and swallowed — the NEXT firing is the
 *     recovery path (still-due customers just wait for it).
 *
 * The timer is `unref()`d so it never keeps the process alive on its own (tests /
 * graceful shutdown), and it touches Redis ZERO times.
 */
@injectable()
export class MonthlyCreditRestoreScheduler {
  private timer?: NodeJS.Timeout;
  /** True while a sweep is in flight — prevents overlapping runs. */
  private running = false;

  constructor(
    private readonly env: EnvConfig,
    @inject(MonthlyCreditRestoreService) private readonly restore: MonthlyCreditRestoreService
  ) {}

  /**
   * Start the recurring sweep. Runs one sweep shortly after boot (so a customer who
   * became due while the server was down is restored promptly after a deploy), then
   * every {@link EnvConfig.monthlyRestoreIntervalMs}. Idempotent — a second call
   * while already started is a no-op.
   */
  start(): void {
    if (this.timer) return;

    const intervalMs = this.env.monthlyRestoreIntervalMs;
    this.timer = setInterval(() => void this.sweep(), intervalMs);
    // Don't let the sweep timer alone hold the event loop open.
    this.timer.unref?.();

    console.log(
      `🗓️ Monthly credit-restore scheduler started (every ${Math.round(intervalMs / 1000)}s, no Redis).`
    );

    // Kick off an immediate sweep without blocking startup.
    void this.sweep();
  }

  /** Stop the recurring sweep (graceful shutdown / tests). */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * Run one sweep, guarded against overlap and never throwing. Exposed for tests to
   * drive a single firing deterministically.
   */
  async sweep(): Promise<void> {
    if (this.running) {
      console.log("⏭️ Monthly credit-restore sweep already running — skipping this tick.");
      return;
    }
    this.running = true;
    try {
      const summary = await this.restore.restoreDue();
      if (summary.restored > 0) {
        console.log(
          `💳 Monthly credit-restore sweep complete: ${summary.restored} customer(s) restored.`
        );
      }
    } catch (err) {
      console.error("💥 Monthly credit-restore sweep failed:", (err as Error)?.message);
    } finally {
      this.running = false;
    }
  }
}
