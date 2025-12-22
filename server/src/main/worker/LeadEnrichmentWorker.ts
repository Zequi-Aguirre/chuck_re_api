import { Worker } from 'bullmq';
import { injectable } from 'tsyringe';
import { EnvConfig } from '../config/EnvConfig';
import { RedisContainer } from '../config/RedisContainer';
import { LeadEnrichmentService } from '../services/LeadEnrichmentService';
import { EnrichmentJobPayload } from '../types/LeadEnrichment';

@injectable()
export class LeadEnrichmentWorker {
  constructor(
    private readonly env: EnvConfig,
    private readonly redis: RedisContainer,
    private readonly svc: LeadEnrichmentService
  ) {}

  /**
   * Start the BullMQ worker that processes enrichment jobs.
   * It will stay alive and automatically pick up new jobs as they arrive.
   */
  public start(): Worker<EnrichmentJobPayload> {
    const worker = new Worker<EnrichmentJobPayload>(
      this.env.enrichQueueName,
      async (job) => {
        try {
          const result = await this.svc.processJob(job.data);
          console.log(`✅ Processed job ${job.id}:`, result);
          return result;
        } catch (err) {
          console.error(`❌ Job ${job.id} failed:`, err);
          throw err;
        }
      },
      {
        connection: this.redis.redis,
        concurrency: 5,
        limiter: {
          max: this.env.enrichRatePerSecond,
          duration: 1000,
        },
      }
    );

    worker.on('completed', (job) => {
      console.log(`✅ Job completed: ${job.id}`);
    });

    worker.on('failed', (job, err) => {
      console.error(`❌ Job failed: ${job?.id}`, err);
    });

    console.log(`🚀 LeadEnrichmentWorker started (queue: ${this.env.enrichQueueName})`);
    return worker;
  }
}