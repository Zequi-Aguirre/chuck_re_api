import "reflect-metadata";
import dotenv from "dotenv";
import express, { Express } from "express";
import http from "http";
import { container } from "tsyringe";

import { appConfig } from "./config";
import { EnvConfig } from "./config/envConfig.ts";
import { Authenticator } from "./middleware/authenticator.ts";

// Resources
import { GhlWebhookResource } from "./resources/GhlWebhookResource.ts";

dotenv.config();

export class ChuckREAPILocalServer {
    private readonly app: Express;
    private httpServer?: http.Server;

    constructor(private readonly config: EnvConfig) {
        this.config = config;
        this.app = express();
    }

    async setup(): Promise<ChuckREAPILocalServer> {
        appConfig(this.app);

        // Create HTTP server manually
        this.httpServer = http.createServer(this.app);

        // DI: register config
        container.registerInstance(EnvConfig, this.config);

        // Auth
        const authenticator = container.resolve(Authenticator);
        container.registerInstance(Authenticator, authenticator);
        const authenticateApiKey = authenticator.authenticateApiKeyFunc();

        // APIs (protected)
        this.app.use(
            "/api/ghl",
            authenticateApiKey,
            container.resolve(GhlWebhookResource).router
        );

        // catch all unhandled errors in the application
        process
            .on("unhandledRejection", (reason, p) => {
                console.error("Unhandled Rejection at:", p, "\nReason:", reason);
            })
            .on("uncaughtException", (error: Error) => {
                console.error(`Caught exception: ${error}\n` + `Exception origin: ${error.stack}`);
            });

        return this;
    }

    getApp() {
        return this.app;
    }

    getHttpServer() {
        return this.httpServer;
    }
}