/**
 * GHL auto-enrichment job queue (JAK-181, epic JAK-180).
 *
 * The Redis-backed foundation that lets a bulk upload (e.g. a 500-lead file →
 * 500 new GHL contacts) enqueue enrichment work SAFELY, without hammering REAPI
 * or GHL. It owns a BullMQ {@link Queue} plus the injectable {@link enqueue}
 * producer; the CONSUMER (worker processor) is JAK-183 and the PRODUCER endpoint
 * (bulk / webhook intake) is JAK-182 — neither is built here.
 *
 * It reuses the SAME Upstash Redis the JAK-072 monthly-credit-restore worker runs
 * on — the shared {@link RedisContainer} (ioredis/TCP client) — and adds NO new
 * Redis provider. Mirrors the existing {@link
 * import("../../services/LeadEnrichmentQueueService").LeadEnrichmentQueueService}
 * and {@link
 * import("../../services/MonthlyCreditRestoreQueueService").MonthlyCreditRestoreQueueService}
 * queue shape so the module stays consistent.
 *
 * Three guardrails make bulk-safe enqueue the default:
 *   - CONCURRENCY cap — {@link concurrency} (env `AUTO_ENRICH_CONCURRENCY`, default
 *     5) bounds how many jobs the JAK-183 worker runs at once, keeping REAPI/GHL
 *     within rate limits. Exposed here as the single source the worker reads; this
 *     ticket does not start a worker.
 *   - RETRY with exponential BACKOFF — every job carries `attempts` +
 *     `{ type: "exponential" }` backoff so a transient 429/5xx is retried, spaced
 *     out. (Which errors are retryable vs terminal is the JAK-183 worker's call —
 *     it throws to retry, or `UnrecoverableError` to stop.)
 *   - DEDUPE by contactId — the BullMQ `jobId` is the `contactId`, so a contact
 *     re-fired while an earlier job for it is still waiting/active is ignored
 *     rather than double-processed.
 *
 * Like the other queues, it's a lazy DI singleton: nothing connects to Redis at
 * registration — the queue is constructed only when this service is first
 * resolved (JAK-182), which happens only on a Redis-configured boot.
 */
import { Queue, JobsOptions } from "bullmq";
import { injectable, inject } from "tsyringe";
import { EnvConfig } from "../../config/envConfig";
import { RedisContainer } from "../../config/RedisContainer";
import { AutoEnrichmentJobPayload } from "./AutoEnrichmentQueueTypes";

@injectable()
export class AutoEnrichmentQueueService {
  /** BullMQ job name for every auto-enrichment job (one type on this queue). */
  public static readonly JOB_NAME = "ghl-auto-enrichment";

  private readonly queue: Queue<AutoEnrichmentJobPayload>;

  /** The queue's Redis key namespace (env-configurable). */
  public readonly queueName: string;

  /**
   * Worker concurrency cap for JAK-183 — the single source of the rate-limit
   * budget. Surfaced on the producer so the consumer reads ONE value.
   */
  public readonly concurrency: number;

  constructor(
    private readonly env: EnvConfig,
    @inject(RedisContainer) private readonly redis: RedisContainer
  ) {
    this.queueName = env.autoEnrichQueueName;
    this.concurrency = env.autoEnrichConcurrency;

    this.queue = new Queue<AutoEnrichmentJobPayload>(this.queueName, {
      // Reuse the shared ioredis/TCP client from RedisContainer — same Upstash
      // Redis as the monthly-restore worker; NO new provider/connection.
      connection: this.redis.redis as any,
      defaultJobOptions: {
        // Bounded exponential-backoff retries for transient failures (429/5xx).
        // BullMQ's built-in "exponential" strategy needs no worker-side custom
        // strategy, so the retry policy is fully defined here on the producer.
        attempts: this.env.autoEnrichMaxAttempts,
        backoff: {
          type: "exponential",
          delay: this.env.autoEnrichBackoffMs,
        },
        // Keep the queue tidy on success; RETAIN failures as the dead-letter so a
        // terminally-failed contact is inspectable / requeueable by JAK-183, never
        // silently dropped.
        removeOnComplete: true,
        removeOnFail: false,
      },
    });

    console.log(`✅ AutoEnrichmentQueue initialized: ${this.queueName}`);
  }

  /**
   * Enqueue one contact for enrichment. DEDUPES on `contactId`: the BullMQ `jobId`
   * is forced to the contactId (caller opts can't override it), so a re-fired
   * contact whose earlier job is still waiting/active is ignored rather than
   * double-processed. Returns the BullMQ job (existing job on a dedupe hit).
   *
   * Producer-only — this never runs the enrichment (that's JAK-183). Callers may
   * pass extra {@link JobsOptions} (e.g. `priority`, `delay`); `jobId` is reserved.
   */
  public async enqueue(payload: AutoEnrichmentJobPayload, opts?: JobsOptions) {
    return this.queue.add(AutoEnrichmentQueueService.JOB_NAME, payload, {
      ...opts,
      // Last so a caller can never override the dedupe key.
      jobId: payload.contactId,
    });
  }

  /** Close the underlying BullMQ queue (releases its Redis resources). */
  public async close(): Promise<void> {
    await this.queue.close();
  }
}
