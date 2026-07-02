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
                // JAK-107: allow a couple of retries with backoff for transient GHL
                // failures; keep failed jobs (removeOnFail:false) as a minimal
                // dead-letter for JAK-111 to harden. Permanent failures throw
                // UnrecoverableError in the worker and skip straight to failed.
                removeOnComplete: true,
                removeOnFail: false,
                attempts: 3,
                backoff: { type: "exponential", delay: 2000 },
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
                        await this.enrichmentWorker.process(job.data);
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
                }
            );

            worker.on("completed", (job) =>
                console.log(`🎉 Lead enrichment completed: ${job.id}`)
            );
            worker.on("failed", (job, err) =>
                console.error(`💥 Lead enrichment failed: ${job?.id}`, err)
            );

            console.log("🧠 Lead Enrichment Worker successfully started!");
        } catch (err) {
            console.error("❌ Failed to start Lead Enrichment Worker:", err);
        }
    }
}