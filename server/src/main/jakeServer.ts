import "reflect-metadata";
import dotenv from "dotenv";
import express, { Express } from "express";
import http from "http";
import cors from "cors";
import { container } from "tsyringe";

import { appConfig } from "./config";
import { EnvConfig } from "./config/envConfig.ts";
import { registerDependencies } from "./di/registerDependencies.ts";
import { Authenticator } from "./middleware/authenticator.ts";

// Resources
import { MailerResource } from "./resources/MailerResource.ts";
import { GhlWebhookResource } from "./resources/GhlWebhookResource.ts";
import { JakeSmsResource } from "./resources/JakeSmsResource.ts";
import { GhlEnrichmentWebhookResource, GhlStatusResource } from "./ghlEnrichment/index.ts";
// Services
import { LeadEnrichmentQueueService } from "./services/LeadEnrichmentQueueService.ts";

dotenv.config();

export class JakeServer {
    private readonly app: Express;
    private httpServer?: http.Server;

    constructor(private readonly config: EnvConfig) {
        this.app = express();
    }

    /**
     * Bootstraps and configures the Express server and background worker.
     */
    async setup(): Promise<JakeServer> {
        appConfig(this.app);

        // Create HTTP server manually
        this.httpServer = http.createServer(this.app);

        // Dependency Injection setup
        container.registerInstance(EnvConfig, this.config);
        registerDependencies();

        const authenticator = container.resolve(Authenticator);
        container.registerInstance(Authenticator, authenticator);

        // 🌐 Middleware
        this.app.use(cors());

        // The lead-enrichment pipeline (Redis queue + worker) is parked legacy
        // functionality — it is only wired up when Redis is actually configured,
        // so the MVP server boots cleanly on environments without Redis secrets.
        const redisConfigured = Boolean(this.config.upstashRedisTcpUrl?.trim());

        // 🪝 JAK-106 — inbound GHL ContactCreate webhook. Mounted BEFORE the
        // app-wide express.json() so its route-scoped parser can capture the RAW
        // request body for signature verification (the global parser then no-ops
        // for this path). Gated on Redis, since it enqueues onto the BullMQ queue.
        if (redisConfigured) {
            this.app.use(
                "/webhooks/ghl",
                container.resolve(GhlEnrichmentWebhookResource).router
            );
        } else {
            console.log("ℹ️ Redis not configured — skipping /webhooks/ghl enrichment webhook.");
        }

        this.app.use(express.json());

        // 📊 JAK-112 — read-only enrichment status API (internal, MASTER_API_KEY
        // protected). NOT gated on Redis: it only reads Postgres, so it works even
        // on a queue-less boot. Mounted BEFORE /api/ghl so its more specific
        // /api/ghl/status prefix is matched first.
        this.app.use("/api/ghl/status", container.resolve(GhlStatusResource).router);

        // 🧠 API Routes
        if (redisConfigured) {
            this.app.use("/api/ghl", container.resolve(GhlWebhookResource).router);
        } else {
            console.log("ℹ️ Redis not configured — skipping /api/ghl lead-enrichment webhook.");
        }
        this.app.use("/api/mailer", container.resolve(MailerResource).router);
        this.app.use("/api/sms", container.resolve(JakeSmsResource).router);

        // 🚀 Start Lead Enrichment Worker (but NOT the HTTP server)
        if (redisConfigured) {
            try {
                const queueService = container.resolve(LeadEnrichmentQueueService);
                await queueService.startWorker();
                console.log("🧠 Lead Enrichment Worker started successfully.");
            } catch (err) {
                console.error("❌ Failed to start Lead Enrichment Worker:", err);
            }
        } else {
            console.log("ℹ️ Redis not configured — Lead Enrichment Worker not started.");
        }

        // Global error handling
        process
            .on("unhandledRejection", (reason, p) => {
                console.error("Unhandled Rejection at:", p, "\nReason:", reason);
            })
            .on("uncaughtException", (error: Error) => {
                console.error(`Caught exception: ${error}\n` + `Exception origin: ${error.stack}`);
            });

        return this;
    }

    /** Returns the Express app */
    getApp() {
        return this.app;
    }

    /** Returns the HTTP server (not yet listening) */
    getHttpServer() {
        return this.httpServer;
    }
}