import { Queue, Worker } from "bullmq";
import { injectable, inject } from "tsyringe";
import { EnvConfig } from "../config/envConfig.ts";
import { RedisContainer } from "../config/RedisContainer.ts";
import { MonthlyCreditRestoreService } from "../ghlEnrichment/metering/MonthlyCreditRestoreService.ts";

/**
 * BullMQ scheduler + worker for the monthly credit RESTORE sweep
 * (JAK-monthly-credit-restore).
 *
 * Mirrors {@link import("./LeadEnrichmentQueueService").LeadEnrichmentQueueService}
 * — a Queue plus a Worker on the same Redis — but instead of consuming jobs an
 * external event enqueues, it registers ONE repeatable (cron) job scheduler that
 * BullMQ fires on the configured cadence (default hourly). Each firing runs
 * {@link MonthlyCreditRestoreService.restoreDue}, which drains every customer
 * whose `next_reset_at` is due.
 *
 * The cadence is just "how often we sweep", NOT "how often a customer is
 * restored": the per-customer atomic guard caps each customer at one restore per
 * monthly cycle, so a firing that finds nobody due is a cheap no-op. Running
 * often only shortens the lag between a customer becoming due and their restore.
 *
 * Like the enrichment worker, this is wired up ONLY when Redis is configured, so
 * a queue-less boot (dev without Redis secrets) starts cleanly — the sweep simply
 * doesn't run there.
 */
@injectable()
export class MonthlyCreditRestoreQueueService {
  /** Stable scheduler + job name so re-registering on each boot UPSERTS (never duplicates). */
  private static readonly SCHEDULER_ID = "monthly-credit-restore-cron";
  private static readonly JOB_NAME = "monthly-credit-restore";

  private readonly queue: Queue;

  constructor(
    private readonly env: EnvConfig,
    @inject(RedisContainer) private readonly redis: RedisContainer,
    @inject(MonthlyCreditRestoreService) private readonly restore: MonthlyCreditRestoreService
  ) {
    this.queue = new Queue(env.monthlyRestoreQueueName, {
      connection: this.redis.redis as any,
      defaultJobOptions: {
        // A sweep is safe to retry (the per-customer claim is idempotent) and
        // carries no external side effects worth a dead-letter, so keep the queue
        // tidy: drop both completed and failed runs. The NEXT cron firing is the
        // real recovery path — a missed/failed sweep just means the still-due
        // customers wait for it.
        removeOnComplete: true,
        removeOnFail: true,
      },
    });

    console.log(`✅ MonthlyCreditRestoreQueue initialized: ${env.monthlyRestoreQueueName}`);
  }

  /**
   * Register the repeatable cron scheduler and start the worker that runs each
   * firing. `upsertJobScheduler` is idempotent on {@link SCHEDULER_ID}, so
   * re-registering on every boot (or after a cadence change) replaces the
   * schedule rather than stacking duplicates.
   */
  public async startWorker(): Promise<void> {
    try {
      await this.queue.upsertJobScheduler(
        MonthlyCreditRestoreQueueService.SCHEDULER_ID,
        { pattern: this.env.monthlyRestoreCron },
        { name: MonthlyCreditRestoreQueueService.JOB_NAME, data: {} }
      );
      console.log(
        `🗓️ Monthly credit-restore cron registered: "${this.env.monthlyRestoreCron}"`
      );

      const worker = new Worker(
        this.env.monthlyRestoreQueueName,
        async () => {
          const summary = await this.restore.restoreDue();
          console.log(
            `💳 Monthly credit-restore sweep complete: ${summary.restored} customer(s) restored.`
          );
          return summary;
        },
        {
          // A sweep must not run concurrently with itself — overlapping runs would
          // just contend on the same due rows (SKIP LOCKED keeps them correct, but
          // there's no reason to). One at a time.
          concurrency: 1,
          connection: {
            ...this.redis.redis.options,
            maxRetriesPerRequest: null,
            lazyConnect: true,
          } as any,
        }
      );

      worker.on("failed", (job, err) =>
        console.error(`💥 Monthly credit-restore sweep failed: ${job?.id}`, err?.message)
      );

      console.log("💳 Monthly Credit-Restore Worker successfully started!");
    } catch (err) {
      console.error("❌ Failed to start Monthly Credit-Restore Worker:", err);
    }
  }
}
