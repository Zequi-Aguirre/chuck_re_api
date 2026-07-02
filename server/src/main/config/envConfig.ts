import dotenv from "dotenv";
dotenv.config();

export class EnvConfig {
    // 🌐 General app configuration
    public readonly clientUrl: string;
    public readonly envStage: string;
    public readonly jwtSecret: string;
    public readonly localNgrokUrl: string;
    public readonly masterApiKey: string;
    public readonly serverUrl: string;
    public readonly askZoeServerUrl: string;

    // 🧩 Lead Enrichment pipeline (Redis / Queue)
    public readonly redisProvider: string;
    public readonly redisUrl: string;
    public readonly upstashRedisRestUrl: string;
    public readonly upstashRedisRestToken: string;
    public readonly upstashRedisTcpUrl: string;
    public readonly enrichQueueName: string;
    public readonly enrichRatePerSecond: number;

    // 🏡 RealEstate API
    public readonly realEstateApiKey: string;
    public readonly realEstateBaseUrl: string;

    // 🗄️ Postgres (per-location connection/credential store — JAK-102 onward)
    public readonly databaseUrl: string;

    // 🧠 GoHighLevel API
    public readonly ghlApiKey: string;
    public readonly ghlBaseUrl: string;

    // 🧠 GoHighLevel Marketplace app (OAuth + webhooks) — Doppler-provided.
    // Wired now so all GHL secrets live in one place; consumed by later tickets
    // (OAuth install JAK-150, webhook verify JAK-106, credential store JAK-102).
    public readonly ghlClientId: string;
    public readonly ghlClientSecret: string;
    public readonly ghlWebhookSecret: string;
    public readonly ghlCredentialEncKey: string;

    constructor() {
        // 🌐 App
        this.clientUrl = process.env.VITE_ASKZACK_CLIENT_URL!;
        this.serverUrl = process.env.VITE_ASKZACK_SERVER_URL!;
        this.localNgrokUrl = process.env.LOCAL_NGROK_URL!;
        this.envStage = process.env.ENV_STAGE || "dev";
        this.jwtSecret = process.env.JWT_SECRET!;
        this.masterApiKey = process.env.MASTER_API_KEY!;
        this.askZoeServerUrl = process.env.VITE_ASKZOE_SERVER_URL!;

        // 🧩 Redis + Queue (supports both local and Upstash)
        this.redisProvider = process.env.REDIS_PROVIDER ?? "upstash";
        this.redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
        this.upstashRedisRestUrl = process.env.UPSTASH_REDIS_REST_URL!;
        this.upstashRedisRestToken = process.env.UPSTASH_REDIS_REST_TOKEN!;
        this.upstashRedisTcpUrl = process.env.UPSTASH_REDIS_TCP_URL!;
        this.enrichQueueName = process.env.ENRICH_QUEUE_NAME ?? "lead-enrichment";
        this.enrichRatePerSecond = Number(process.env.ENRICH_RPS ?? "5");

        // 🏡 RealEstate API
        this.realEstateApiKey = process.env.RE_API_KEY!;
        this.realEstateBaseUrl = process.env.RE_BASE_URL!;

        // 🗄️ Postgres connection string (Doppler). Optional at boot — the
        // connection store initializes its pool lazily, so environments without
        // a DB provisioned yet (e.g. the current dev queue-less boot) start fine.
        this.databaseUrl = process.env.DATABASE_URL ?? "";

        // 🧠 GoHighLevel API
        this.ghlApiKey = process.env.GHL_API_KEY!;
        this.ghlBaseUrl = process.env.GHL_BASE_URL!;

        // 🧠 GoHighLevel Marketplace app secrets (Doppler)
        this.ghlClientId = process.env.GHL_CLIENT_ID ?? "";
        this.ghlClientSecret = process.env.GHL_CLIENT_SECRET ?? "";
        this.ghlWebhookSecret = process.env.GHL_WEBHOOK_SECRET ?? "";
        this.ghlCredentialEncKey = process.env.GHL_CREDENTIAL_ENC_KEY ?? "";
    }

    // 🌱 Canonical env-stage helper (Automator pattern). This is the single
    // source of truth for "which environment am I in". The dev/staging
    // write-safety rule (SPEC §8: never write to a real GHL sub-account off
    // prod) reads these — do not re-derive the stage anywhere else.
    get isProduction(): boolean {
        const s = this.envStage.toLowerCase();
        return s === "production" || s === "prod";
    }

    get isStaging(): boolean {
        return this.envStage.toLowerCase() === "staging";
    }

    get isDev(): boolean {
        return !this.isProduction && !this.isStaging;
    }
}