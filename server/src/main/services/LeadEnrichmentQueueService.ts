import { Queue, Worker, JobsOptions } from "bullmq";
import { injectable, inject } from "tsyringe";
import { EnvConfig } from "../config/envConfig.ts";
import { RedisContainer } from "../config/RedisContainer.ts";
import { EnrichmentJobPayload } from "../types/LeadEnrichment.ts";
import { LeadEnrichmentService } from "./LeadEnrichmentService.ts";
import { GhlApiDao } from "../data/GhlApiDao.ts";
import { RealEstateApiDao } from "../data/RealEstateApiDao.ts";
import { GhlEnrichmentWorker } from "../ghlEnrichment/worker/GhlEnrichmentWorker.ts";

@injectable()
export class LeadEnrichmentQueueService {
    /** JAK-111 bounded-retry policy for transient failures. */
    private static readonly MAX_ATTEMPTS = 3;
    private static readonly BACKOFF_BASE_MS = 2000;
    private static readonly BACKOFF_MAX_MS = 60_000;
    /** Custom backoff name — wires job retries to {@link jitteredBackoff}. */
    private static readonly BACKOFF_TYPE = "enrichment-jittered";

    private readonly queue: Queue<EnrichmentJobPayload>;

    constructor(
        private readonly env: EnvConfig,
        @inject(RedisContainer) private readonly redis: RedisContainer,
        private readonly ghlDao: GhlApiDao,
        private readonly realEstateDao: RealEstateApiDao,
        @inject(GhlEnrichmentWorker) private readonly enrichmentWorker: GhlEnrichmentWorker
    ) {
        console.log(`✅ Connected to Upstash Redis REST: ${env.upstashRedisRestUrl}`);

        this.queue = new Queue<EnrichmentJobPayload>(env.enrichQueueName, {
            connection: this.redis.redis as any,
            defaultJobOptions: {
                // JAK-111: bounded retries for transient failures with exponential
                // backoff + jitter (the custom strategy below — jitter spreads a
                // thundering herd of simultaneous GHL 429/5xx retries). Failed jobs
                // are kept (removeOnFail:false) as the dead-letter; the worker marks
                // the terminal `dead_letter` state + refunds via the `failed` hook.
                // Permanent failures throw UnrecoverableError and skip retries.
                removeOnComplete: true,
                removeOnFail: false,
                attempts: LeadEnrichmentQueueService.MAX_ATTEMPTS,
                backoff: {
                    type: LeadEnrichmentQueueService.BACKOFF_TYPE,
                    delay: LeadEnrichmentQueueService.BACKOFF_BASE_MS,
                },
            },
        });

        console.log(`✅ LeadEnrichmentQueue initialized: ${env.enrichQueueName}`);
    }

    public async enqueue(job: EnrichmentJobPayload, opts?: JobsOptions) {
        return this.queue.add("lead-enrichment", job, opts);
    }

    public async startWorker(): Promise<void> {
        try {
            const worker = new Worker<EnrichmentJobPayload>(
                this.env.enrichQueueName,
                async (job) => {
                    console.log(`🧠 Processing job: ${job.id}`);

                    // JAK-107: multi-tenant jobs (the JAK-106 webhook path carries a
                    // location_id) go to the enrichment worker — per-location creds,
                    // JAK-108 field mapping, write-back + note, idempotency. Legacy
                    // single-tenant MVP jobs (no location_id) keep the parked service.
                    if (job.data.location_id) {
                        // Thread the BullMQ attempt number through so the worker
                        // records it on the event row (inspection / requeue context).
                        await this.enrichmentWorker.process(job.data, {
                            attempt: job.attemptsMade + 1,
                        });
                    } else {
                        const enrichmentService = new LeadEnrichmentService(
                            this.ghlDao,
                            this.realEstateDao
                        );
                        await enrichmentService.processLead(job.data);
                    }
                    console.log(`✅ Job completed: ${job.id}`);
                },
                {
                    concurrency: this.env.enrichRatePerSecond,
                    connection: {
                        ...this.redis.redis.options,
                        maxRetriesPerRequest: null,
                        lazyConnect: true,
                    } as any,
                    // JAK-111: exponential backoff WITH jitter for retried transient
                    // failures. BullMQ's built-in "exponential" has no jitter, so a
                    // burst of jobs that all hit a GHL 429 would retry in lockstep;
                    // the jitter spreads them out.
                    settings: {
                        backoffStrategy: (attemptsMade: number) =>
                            LeadEnrichmentQueueService.jitteredBackoff(attemptsMade),
                    },
                }
            );

            worker.on("completed", (job) =>
                console.log(`🎉 Lead enrichment completed: ${job.id}`)
            );

            // JAK-111 dead-letter hook. BullMQ fires `failed` on EVERY failed
            // attempt; we only finalize when it has TERMINALLY given up — retries
            // exhausted (attemptsMade >= attempts) or a permanent UnrecoverableError
            // (which BullMQ moves straight to the failed set). On the multi-tenant
            // path that hands off to the worker to mark `dead_letter` + refund any
            // charge, so nothing is silently lost and we never bill for a failure.
            worker.on("failed", async (job, err) => {
                console.error(`💥 Lead enrichment failed: ${job?.id}`, err?.message);
                if (!job?.data.location_id) return;
                const maxAttempts = job.opts.attempts ?? 1;
                const exhausted = job.attemptsMade >= maxAttempts;
                const permanent = err?.name === "UnrecoverableError";
                if (!exhausted && !permanent) return; // will retry — not terminal yet
                try {
                    await this.enrichmentWorker.finalizeFailure(
                        job.data,
                        err?.message ?? "unknown error"
                    );
                } catch (finalizeErr) {
                    console.error(
                        `❌ Failed to finalize dead-letter for job ${job.id}:`,
                        (finalizeErr as Error)?.message
                    );
                }
            });

            console.log("🧠 Lead Enrichment Worker successfully started!");
        } catch (err) {
            console.error("❌ Failed to start Lead Enrichment Worker:", err);
        }
    }

    /**
     * Delay (ms) before retrying a failed job: exponential in the attempt count,
     * with additive jitter, capped. `attemptsMade` is 1-based on the first retry.
     * Exponential = base·2^(attemptsMade-1); jitter adds up to one base interval
     * so simultaneous failures don't retry in lockstep (thundering herd).
     */
    private static jitteredBackoff(attemptsMade: number): number {
        const exponent = Math.max(0, attemptsMade - 1);
        const exponential = LeadEnrichmentQueueService.BACKOFF_BASE_MS * 2 ** exponent;
        const jitter = Math.floor(Math.random() * LeadEnrichmentQueueService.BACKOFF_BASE_MS);
        return Math.min(exponential + jitter, LeadEnrichmentQueueService.BACKOFF_MAX_MS);
    }
}