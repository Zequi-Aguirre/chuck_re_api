import { injectable } from "tsyringe";
import { Redis as UpstashRedis } from "@upstash/redis";
import { EnvConfig } from "./EnvConfig";

@injectable()
export class RedisContainer {
  public readonly redis: UpstashRedis | any;

  constructor(private readonly env: EnvConfig) {
    if (this.env.redisProvider === "upstash") {
      // ✅ Upstash REST-based Redis
      this.redis = new UpstashRedis({
        url: this.env.upstashRedisUrl,
        token: this.env.upstashRedisToken,
      });

      console.log("✅ Connected to Upstash Redis:", this.env.upstashRedisUrl);
    } else {
      // 🧩 Fallback: Local Redis via ioredis
      const IORedis = require("ioredis");
      this.redis = new IORedis(this.env.redisUrl, {
        maxRetriesPerRequest: null,
        enableReadyCheck: true,
      });

      console.log("✅ Connected to Local Redis:", this.env.redisUrl);
    }
  }
}