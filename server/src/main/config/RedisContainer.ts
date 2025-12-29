import { injectable } from "tsyringe";
import { Redis } from "@upstash/redis";
import IORedis from "ioredis";
import { EnvConfig } from "./envConfig.ts";

@injectable()
export class RedisContainer {
  public readonly redis: IORedis; // For BullMQ (TCP)
  public readonly upstash: Redis; // For REST interactions

  constructor(private readonly env: EnvConfig) {
    // ✅ Upstash REST client
    this.upstash = new Redis({
      url: this.env.upstashRedisRestUrl,
      token: this.env.upstashRedisRestToken,
    });

    // ✅ BullMQ / ioredis client (TLS over TCP)
    this.redis = new IORedis(this.env.upstashRedisTcpUrl, {
      tls: { rejectUnauthorized: false },
    });

    console.log(`✅ Connected to Upstash Redis REST: ${this.env.upstashRedisRestUrl}`);
  }
}