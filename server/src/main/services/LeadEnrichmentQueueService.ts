import { injectable } from 'tsyringe';
import { Queue } from 'bullmq';
import { EnvConfig } from '../config/EnvConfig';
import { RedisContainer } from '../config/RedisContainer';
import { EnrichmentJobPayload } from '../types/LeadEnrichment';

@injectable()
export class LeadEnrichmentQueueService {
  private readonly queue: Queue<EnrichmentJobPayload>;

  constructor(env: EnvConfig, redis: RedisContainer) {
    this.queue = new Queue<EnrichmentJobPayload>(env.enrichQueueName, {
      connection: redis.redis,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 30_000 },
        removeOnComplete: 5000,
        removeOnFail: 5000,
      },
    });
  }

  /**
   * Enqueue a new enrichment job.
   * Each job is idempotent by contact/location pair.
   */
  public async enqueue(payload: EnrichmentJobPayload): Promise<string> {
    const jobId = `${payload.locationId}:${payload.contactId}`;

    const job = await this.queue.add('enrich-lead', payload, {
      jobId, // idempotency — if same ID exists, it won’t duplicate
    });

    return job.id ?? jobId;
  }
}