import dotenv from "dotenv";
dotenv.config();

/**
 * Parse a non-negative integer from an env var, falling back to `fallback` when
 * the value is missing, non-numeric, negative, or fractional. Used for tunable
 * pricing constants (JAK-109 credit costs) where a malformed override must never
 * silently zero out a charge.
 */
function positiveIntFromEnv(raw: string | undefined, fallback: number): number {
    if (raw === undefined || raw.trim() === "") return fallback;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 ? n : fallback;
}

export class EnvConfig {
    // 🌐 General app configuration
    public readonly envStage: string;
    public readonly jwtSecret: string;
    public readonly masterApiKey: string;

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

    // 🗄️ Postgres (per-location connection/credential store — JAK-102 onward).
    // HOUSE PATTERN (JAK-117): discrete connection vars mirroring Automator +
    // Northstar (DB_HOST/DB_PORT/DB_USER/DB_PASS/DB_DB) instead of a single
    // DATABASE_URL. Same var names as Automator's DBConfig so ops/Doppler stay
    // consistent across the fleet.
    public readonly dbHost: string;
    public readonly dbPort: string;
    public readonly dbUser: string;
    public readonly dbPass: string;
    public readonly dbDb: string;

    // 🧠 GoHighLevel API
    public readonly ghlApiKey: string;
    public readonly ghlBaseUrl: string;

    // 📟 Text-Jake MASTER GATEWAY (JAK-115). The single Zequi-owned "Jake" GHL
    // sub-account that fronts tier-1 / trial texting: inbound arrives here and
    // Jake replies out through it on this ONE master key. App-level Doppler
    // secrets — NEVER stored in the DB and NEVER per-tenant. Optional at boot
    // (empty when unset); the gateway client fails loudly only if actually used
    // without them configured.
    public readonly jakeGatewayGhlApiKey: string;
    public readonly jakeGatewayLocationId: string;
    public readonly jakeGatewayBaseUrl: string;

    // 🧠 GoHighLevel Marketplace app (OAuth + webhooks) — Doppler-provided.
    // Wired now so all GHL secrets live in one place; consumed by later tickets
    // (OAuth install JAK-150, webhook verify JAK-106, credential store JAK-102).
    public readonly ghlClientId: string;
    public readonly ghlClientSecret: string;
    public readonly ghlWebhookSecret: string;
    public readonly ghlCredentialEncKey: string;

    // 🎟️ Credit metering (JAK-109). Per-operation credit costs, config-driven so
    // the economics can be tuned without a code change (these are NOT secrets —
    // just tunable pricing constants with safe defaults).
    public readonly creditCostEnrichment: number;
    public readonly creditCostSkipTrace: number;
    // Credits per tier-1 text-Jake property lookup (JAK-115). Same config-driven,
    // never-free, safe-default treatment as the enrichment costs above.
    public readonly creditCostTextLookup: number;

    // 🔐 Admin dashboard (JAK-113). The first-admin bootstrap credentials come
    // from Doppler — NEVER hardcoded in code or a migration. On boot, if both are
    // set and no admin with that email exists yet, one is created (password
    // bcrypt-hashed). Leave them unset once the admin exists. The session TTL
    // governs how long an issued admin JWT stays valid.
    public readonly adminSeedEmail: string;
    public readonly adminSeedPassword: string;
    public readonly adminSessionTtlHours: number;

    constructor() {
        // 🌐 App
        this.envStage = process.env.ENV_STAGE || "dev";
        this.jwtSecret = process.env.JWT_SECRET!;
        this.masterApiKey = process.env.MASTER_API_KEY!;

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

        // 🗄️ Postgres discrete connection vars (Doppler). HOUSE PATTERN shared
        // with Automator + Northstar — same DB_* var names. Optional at boot —
        // the connection store initializes its pool lazily, so environments
        // without a DB provisioned yet (e.g. the current dev queue-less boot)
        // start fine.
        this.dbHost = process.env.DB_HOST ?? "";
        this.dbPort = process.env.DB_PORT ?? "";
        this.dbUser = process.env.DB_USER ?? "";
        this.dbPass = process.env.DB_PASS ?? "";
        this.dbDb = process.env.DB_DB ?? "";

        // 🧠 GoHighLevel API
        this.ghlApiKey = process.env.GHL_API_KEY!;
        this.ghlBaseUrl = process.env.GHL_BASE_URL!;

        // 📟 Text-Jake master gateway (JAK-115). App-level, Doppler-only. Optional
        // at boot so environments without a gateway configured still start; the
        // JakeGatewayClient throws if a gateway send/note is attempted unset.
        this.jakeGatewayGhlApiKey = process.env.JAKE_GATEWAY_GHL_API_KEY ?? "";
        this.jakeGatewayLocationId = process.env.JAKE_GATEWAY_LOCATION_ID ?? "";
        this.jakeGatewayBaseUrl = process.env.JAKE_GATEWAY_BASE_URL ?? "";

        // 🧠 GoHighLevel Marketplace app secrets (Doppler)
        this.ghlClientId = process.env.GHL_CLIENT_ID ?? "";
        this.ghlClientSecret = process.env.GHL_CLIENT_SECRET ?? "";
        this.ghlWebhookSecret = process.env.GHL_WEBHOOK_SECRET ?? "";
        this.ghlCredentialEncKey = process.env.GHL_CREDENTIAL_ENC_KEY ?? "";

        // 🎟️ Credit costs (JAK-109). Defaults: 1 credit per enriched record, +2
        // extra for a skip-trace on top of it. Override per environment via
        // Doppler when the economics firm up. Non-finite/negative values fall
        // back to the default so a bad env var can never make work "free".
        this.creditCostEnrichment = positiveIntFromEnv(process.env.CREDIT_COST_ENRICHMENT, 1);
        this.creditCostSkipTrace = positiveIntFromEnv(process.env.CREDIT_COST_SKIP_TRACE, 2);
        this.creditCostTextLookup = positiveIntFromEnv(process.env.CREDIT_COST_TEXT_LOOKUP, 1);

        // 🔐 Admin dashboard bootstrap (JAK-113). Optional — unset on environments
        // where the admin already exists. Never defaulted to a real credential.
        this.adminSeedEmail = process.env.ADMIN_SEED_EMAIL ?? "";
        this.adminSeedPassword = process.env.ADMIN_SEED_PASSWORD ?? "";
        this.adminSessionTtlHours = positiveIntFromEnv(process.env.ADMIN_SESSION_TTL_HOURS, 12);
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