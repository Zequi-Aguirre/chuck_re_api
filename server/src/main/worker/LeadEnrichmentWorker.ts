import { Worker, Job } from "bullmq";
import { container } from "tsyringe";
import { EnvConfig } from "../config/envConfig";
import { RedisContainer } from "../config/RedisContainer";
import { LeadEnrichmentService } from "../services/LeadEnrichmentService";
import { EnrichmentJobPayload } from "../types/LeadEnrichment";

export class LeadEnrichmentWorker {
  private readonly worker: Worker<EnrichmentJobPayload> | null = null;

  constructor() {
    const env = container.resolve(EnvConfig);
    const redisContainer = container.resolve(RedisContainer);

    // Upstash REST API is not compatible with BullMQ Worker
    if (env.redisProvider === "upstash") {
      console.warn(
          "⚠️ Upstash Redis detected — BullMQ Worker is disabled (REST API is not supported for queues).\n" +
          "You can still use the LeadEnrichmentService directly for API-triggered enrichment."
      );
      return;
    }

    // ✅ Create BullMQ Worker when using local Redis
    this.worker = new Worker<EnrichmentJobPayload>(
        env.enrichQueueName,
        async (job: Job<EnrichmentJobPayload>) => {
          const leadEnrichmentService = container.resolve(LeadEnrichmentService);
          console.log(`🧠 Processing job: ${job.id} (${job.name})`);

          try {
            await leadEnrichmentService.processLead(job.data);
            console.log(`✅ Lead enrichment completed: ${job.id}`);
          } catch (err) {
            console.error(`❌ Lead enrichment failed (${job.id}):`, err);
            throw err;
          }
        },
        {
          connection: redisContainer.redis,
          concurrency: Number(process.env.WORKER_CONCURRENCY ?? 5),
        }
    );

    // Worker lifecycle events
    this.worker.on("completed", (job) =>
        console.log(`🎯 Job completed → ${job.id}`)
    );

    this.worker.on("failed", (job, err) =>
        console.error(`💥 Job failed → ${job?.id}:`, err.message)
    );

    console.log(`👷 Lead Enrichment Worker initialized for queue: ${env.enrichQueueName}`);
  }
}