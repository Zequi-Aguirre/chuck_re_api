import { Router, Request, Response, NextFunction } from "express";
import { injectable } from "tsyringe";
import { EnvConfig } from "../config/envConfig.ts";
import { JakeAssistantService } from "../services/JakeAssistantService.ts";
import { JakeInboundMessage } from "../types/Jake.ts";

/**
 * Inbound SMS webhook. A single GHL automation POSTs here with the inbound
 * message + contact info; the server validates the address, looks up the
 * property, and replies over SMS. Protected by a MASTER_API_KEY header.
 */
@injectable()
export class JakeSmsResource {
    public readonly router: Router;

    constructor(
        private readonly env: EnvConfig,
        private readonly assistant: JakeAssistantService
    ) {
        this.router = Router();
        this.configureRoutes();
    }

    private configureRoutes(): void {
        this.router.post("/inbound", this.requireMasterApiKey.bind(this), this.handleInbound.bind(this));
    }

    /** Reject requests without a valid MASTER_API_KEY header. */
    private requireMasterApiKey(req: Request, res: Response, next: NextFunction): Response | void {
        const provided = req.header("x-master-api-key") ?? req.header("x-api-key");
        const expected = this.env.masterApiKey;

        if (!expected) {
            console.error("❌ MASTER_API_KEY is not configured on the server.");
            return res.status(500).json({ ok: false, error: "Server auth not configured" });
        }
        if (!provided || provided !== expected) {
            return res.status(401).json({ ok: false, error: "Unauthorized" });
        }
        return next();
    }

    private async handleInbound(req: Request, res: Response): Promise<Response> {
        try {
            const body = req.body ?? {};

            const contactId: string | undefined = body.contactId ?? body.contact_id ?? body.userId;
            const message: string | undefined = body.message ?? body.body ?? body.text;
            const fromNumber: string | undefined = body.fromNumber ?? body.from_number;

            if (!contactId || !message || !String(message).trim()) {
                return res
                    .status(400)
                    .json({ ok: false, error: "Missing required fields: contactId and message" });
            }

            const input: JakeInboundMessage = {
                contactId: String(contactId),
                message: String(message),
                fromNumber: fromNumber ? String(fromNumber) : undefined,
            };

            const result = await this.assistant.handleInboundMessage(input);
            return res.status(200).json(result);
        } catch (err) {
            console.error("❌ JakeSmsResource.handleInbound error:", err);
            return res.status(500).json({ ok: false, error: "Internal Server Error" });
        }
    }
}
