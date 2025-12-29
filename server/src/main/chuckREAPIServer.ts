import "reflect-metadata";
import dotenv from "dotenv";
import express, { Express } from "express";
import http from "http";
import cors from "cors";
import { container } from "tsyringe";

import { appConfig } from "./config/index.ts";
import { EnvConfig } from "./config/envConfig.ts";
import { Authenticator } from "./middleware/authenticator.ts";

// Resources
import { GhlWebhookResource } from "./resources/GhlWebhookResource.ts";
// Services
import { LeadEnrichmentQueueService } from "./services/LeadEnrichmentQueueService.ts";

dotenv.config();

export class ChuckREAPIServer {
    private readonly app: Express;
    private httpServer?: http.Server;

    constructor(private readonly config: EnvConfig) {
        this.app = express();
    }

    /**
     * Bootstraps and configures the Express server and background worker.
     */
    async setup(): Promise<ChuckREAPIServer> {
        appConfig(this.app);

        // Create HTTP server manually
        this.httpServer = http.createServer(this.app);

        // Dependency Injection setup
        container.registerInstance(EnvConfig, this.config);

        const authenticator = container.resolve(Authenticator);
        container.registerInstance(Authenticator, authenticator);

        // 🌐 Middleware
        this.app.use(cors());
        this.app.use(express.json());

        // 🧠 API Routes
        this.app.use("/api/ghl", container.resolve(GhlWebhookResource).router);

        // 🚀 Start Lead Enrichment Worker (but NOT the HTTP server)
        try {
            const queueService = container.resolve(LeadEnrichmentQueueService);
            await queueService.startWorker();
            console.log("🧠 Lead Enrichment Worker started successfully.");
        } catch (err) {
            console.error("❌ Failed to start Lead Enrichment Worker:", err);
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