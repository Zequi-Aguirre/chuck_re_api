import { Router, Request, Response, NextFunction } from "express";
import { injectable } from "tsyringe";
import { EnvConfig } from "../config/envConfig.ts";
import { JakeAssistantService } from "../services/JakeAssistantService.ts";
import { JakeInboundMessage } from "../types/Jake.ts";

/**
 * Inbound SMS webhook for text-Jake (JAK-115, mode-aware). A GHL automation POSTs
 * here with the inbound message + contact info. The transport is guarded by the
 * app-level MASTER_API_KEY header (an app secret Doppler holds — NOT a GHL/tenant
 * credential, and NOT the master GATEWAY key). Beyond that, this resource just
 * normalizes GHL's flexible field names and hands the assistant a clean shape:
 *
 *  - the SENDER phone (the person texting in) → the billing identity, used in
 *    BOTH text modes to resolve the customer + their credit account;
 *  - the location id / destination number the text arrived on → lets the
 *    assistant resolve an own_number connection (JAK-114) vs the shared gateway.
 *
 * Mode selection and all credential handling live in the assistant, so this
 * resource never touches a GHL key of any kind.
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

            // The SENDER's number — the person who texted in. This is the billing
            // identity in BOTH modes. GHL webhooks vary, so accept the common shapes.
            const senderPhone: string | undefined =
                body.from ?? body.fromNumber ?? body.from_number ?? body.phone;

            // Routing keys for own_number resolution: the sub-account id and the
            // destination number the text was received on (the tenant's own number).
            const locationId: string | undefined = body.locationId ?? body.location_id;
            const toNumber: string | undefined = body.to ?? body.toNumber ?? body.to_number;

            if (!contactId || !message || !String(message).trim()) {
                return res
                    .status(400)
                    .json({ ok: false, error: "Missing required fields: contactId and message" });
            }
            if (!senderPhone || !String(senderPhone).trim()) {
                return res
                    .status(400)
                    .json({ ok: false, error: "Missing required field: sender phone number" });
            }

            const input: JakeInboundMessage = {
                contactId: String(contactId),
                senderPhone: String(senderPhone),
                message: String(message),
                locationId: locationId ? String(locationId) : undefined,
                candidateNumbers: toNumber ? [String(toNumber)] : [],
            };

            const result = await this.assistant.handleInboundMessage(input);
            return res.status(200).json(result);
        } catch (err) {
            console.error("❌ JakeSmsResource.handleInbound error:", err);
            return res.status(500).json({ ok: false, error: "Internal Server Error" });
        }
    }
}
