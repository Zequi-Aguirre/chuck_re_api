import { Queue, Worker, JobsOptions } from "bullmq";
import { injectable, inject } from "tsyringe";
import { EnvConfig } from "../config/envConfig.ts";
import { RedisContainer } from "../config/RedisContainer.ts";
import { EnrichmentJobPayload } from "../types/LeadEnrichment.ts";
import { LeadEnrichmentService } from "./LeadEnrichmentService.ts";
import { GhlApiDao } from "../data/GhlApiDao.ts";
import { RealEstateApiDao } from "../data/RealEstateApiDao.ts";

@injectable()
export class LeadEnrichmentQueueService {
    private readonly queue: Queue<EnrichmentJobPayload>;

    constructor(
        private readonly env: EnvConfig,
        @inject(RedisContainer) private readonly redis: RedisContainer,
        private readonly ghlDao: GhlApiDao,
        private readonly realEstateDao: RealEstateApiDao
    ) {
        console.log(`✅ Connected to Upstash Redis REST: ${env.upstashRedisRestUrl}`);

        this.queue = new Queue<EnrichmentJobPayload>(env.enrichQueueName, {
            connection: this.redis.redis as any,
            defaultJobOptions: {
                removeOnComplete: true,
                attempts: 1,
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

                    const enrichmentService = new LeadEnrichmentService(
                        this.ghlDao,
                        this.realEstateDao
                    );

                    await enrichmentService.processLead(job.data);
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