import { injectable } from 'tsyringe';
import IORedis from 'ioredis';
import { EnvConfig } from './EnvConfig';

@injectable()
export class RedisContainer {
  public readonly redis: IORedis;

  constructor(private readonly env: EnvConfig) {
    this.redis = new IORedis(this.env.redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
    });

    this.redis.on('connect', () => console.log('✅ Redis connected'));
    this.redis.on('error', (err) => console.error('❌ Redis error:', err));
  }
}