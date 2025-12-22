import dotenv from "dotenv";
dotenv.config();

export class EnvConfig {
    public readonly clientUrl: string;
    public readonly envStage: string = process.env.ENV_STAGE || "dev";
    public readonly jwtSecret: string;
    public readonly localNgrokUrl: string;
    public readonly masterApiKey: string;
    public readonly serverUrl: string;
    public readonly askZoeServerUrl: string;

    // 🧩 Lead Enrichment pipeline
    public readonly redisUrl: string;
    public readonly enrichQueueName: string;
    public readonly enrichRatePerSecond: number;

    // 🏡 RealEstate API
    public readonly realEstateApiKey: string;
    public readonly realEstateBaseUrl: string;

    // 🧠 GoHighLevel API
    public readonly ghlApiKey: string;
    public readonly ghlBaseUrl: string;

    constructor() {
        this.clientUrl = process.env.VITE_ASKZACK_CLIENT_URL!;
        this.serverUrl = process.env.VITE_ASKZACK_SERVER_URL!;
        this.localNgrokUrl = process.env.LOCAL_NGROK_URL!;
        this.envStage = process.env.ENV_STAGE!;
        this.jwtSecret = process.env.JWT_SECRET!;
        this.masterApiKey = process.env.MASTER_API_KEY!;
        this.askZoeServerUrl = process.env.VITE_ASKZOE_SERVER_URL!;

        // 🧩 Redis + Queue
        this.redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
        this.enrichQueueName = process.env.ENRICH_QUEUE_NAME ?? "lead-enrichment";
        this.enrichRatePerSecond = Number(process.env.ENRICH_RPS ?? "5");

        // 🏡 RealEstate API
        this.realEstateApiKey = process.env.RE_API_KEY ?? "";
        this.realEstateBaseUrl = process.env.RE_BASE_URL ?? "https://api.realestateapi.com";

        // 🧠 GoHighLevel API
        this.ghlApiKey = process.env.GHL_API_KEY ?? "";
        this.ghlBaseUrl = process.env.GHL_BASE_URL ?? "https://services.leadconnectorhq.com";
    }
}