import "reflect-metadata";
import dotenv from "dotenv";
import express, { Express } from "express";
import http from "http";
import cors from "cors";
import fs from "fs";
import path from "path";
import { container } from "tsyringe";

import { appConfig } from "./config";
import { EnvConfig } from "./config/envConfig.ts";
import { registerDependencies } from "./di/registerDependencies.ts";
import { Authenticator } from "./middleware/authenticator.ts";

// Resources
import { MailerResource } from "./resources/MailerResource.ts";
import { JakeSmsResource } from "./resources/JakeSmsResource.ts";
import {
    GhlEnrichmentWebhookResource,
    GhlStatusResource,
    AdminAuthResource,
    AdminResource,
    AdminAuthService,
} from "./ghlEnrichment/index.ts";
// Services
import { LeadEnrichmentQueueService } from "./services/LeadEnrichmentQueueService.ts";
import { MonthlyCreditRestoreQueueService } from "./services/MonthlyCreditRestoreQueueService.ts";

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
        this.app.use("/api/mailer", container.resolve(MailerResource).router);
        this.app.use("/api/sms", container.resolve(JakeSmsResource).router);

        // 🔐 JAK-113 — admin dashboard API. NOT gated on Redis: it only reads/writes
        // Postgres (connections, credits, status). Auth endpoints are public
        // (login); everything under /api/admin is session-guarded internally.
        this.app.use("/api/admin/auth", container.resolve(AdminAuthResource).router);
        this.app.use("/api/admin", container.resolve(AdminResource).router);

        // 🖥️ JAK-113 — serve the built React/MUI admin SPA from THIS server (no
        // second server; mirrors the Automator/Northstar single-server pattern).
        this.mountAdminSpa();

        // 🌱 Bootstrap the first admin from Doppler env (never a hardcoded
        // credential). No-ops unless ADMIN_SEED_* are set and the admin is absent.
        await this.seedAdmin();

        // 🚀 Start Lead Enrichment Worker (but NOT the HTTP server)
        if (redisConfigured) {
            try {
                const queueService = container.resolve(LeadEnrichmentQueueService);
                await queueService.startWorker();
                console.log("🧠 Lead Enrichment Worker started successfully.");
            } catch (err) {
                console.error("❌ Failed to start Lead Enrichment Worker:", err);
            }

            // 💳 JAK-monthly-credit-restore — start the repeatable cron sweep that
            // restores each customer's credits to the effective default on their
            // monthly signup anniversary. Gated on Redis (BullMQ), like the
            // enrichment worker; the per-customer next_reset_at guard makes the
            // frequent cadence a cheap no-op for anyone not yet due.
            try {
                const restoreQueue = container.resolve(MonthlyCreditRestoreQueueService);
                await restoreQueue.startWorker();
                console.log("💳 Monthly Credit-Restore Worker started successfully.");
            } catch (err) {
                console.error("❌ Failed to start Monthly Credit-Restore Worker:", err);
            }
        } else {
            console.log(
                "ℹ️ Redis not configured — Lead Enrichment + Monthly Credit-Restore Workers not started."
            );
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

    /**
     * Serve the built admin SPA (client/dist) under /admin from this same server.
     * The React app is built separately (`npm run build-admin`) into client/dist;
     * here we static-serve that build and fall back to index.html for client-side
     * routes (deep links like /admin/connections/:id). If the build isn't present
     * (e.g. a backend-only dev boot), we log and skip — the API still works.
     */
    private mountAdminSpa(): void {
        const clientDist = path.resolve(process.cwd(), "client", "dist");
        const indexHtml = path.join(clientDist, "index.html");

        if (!fs.existsSync(indexHtml)) {
            console.log(
                "ℹ️ Admin SPA build not found at client/dist — skipping /admin " +
                    "(run `npm run build-admin`). The /api/admin API is still mounted."
            );
            return;
        }

        this.app.use("/admin", express.static(clientDist));
        // SPA fallback: any non-file /admin/* path returns the app shell so the
        // client router can handle it. API routes are mounted earlier, so this
        // never shadows them.
        this.app.get(/^\/admin(\/.*)?$/, (_req, res) => {
            res.sendFile(indexHtml);
        });
        console.log("🖥️ Admin SPA served at /admin");
    }

    /** Bootstrap the first admin from env; tolerate a queue-less/DB-less boot. */
    private async seedAdmin(): Promise<void> {
        if (!this.config.dbHost?.trim()) {
            console.log("ℹ️ Postgres (DB_HOST) not set — skipping admin bootstrap.");
            return;
        }
        try {
            const result = await container.resolve(AdminAuthService).seedFirstAdmin();
            if (result === "created")
                console.log("🔐 First admin (superadmin) created from ADMIN_SEED_* env.");
            else if (result === "promoted")
                console.log("🔐 Seeded admin promoted to superadmin (JAK-125).");
            else if (result === "exists")
                console.log("🔐 Superadmin already present — no seed needed.");
        } catch (err) {
            console.error("❌ Admin bootstrap failed:", err);
        }
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