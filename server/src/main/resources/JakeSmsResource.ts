import { Router, Request, Response, NextFunction } from "express";
import { injectable } from "tsyringe";
import { EnvConfig } from "../config/envConfig.ts";
import { JakeAssistantService } from "../services/JakeAssistantService.ts";
import { JakeInboundMessage } from "../types/Jake.ts";
import { normalizeInboundAddress } from "../util/address.ts";

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

    /**
     * Resolve a message-text field GHL may deliver either as a plain string OR as
     * a message OBJECT (`{ type, body }`) — its real inbound payload shape (JAK-128).
     * Returns the string `.body` in the object case, the value as-is when it's
     * already a string, or undefined otherwise. Without this, an object field was
     * coerced via `String(obj)` → "[object Object]", so the address never parsed.
     */
    private static asText(m: unknown): string | undefined {
        if (typeof m === "string") return m;
        if (m && typeof m === "object") {
            const inner = (m as { body?: unknown }).body;
            return typeof inner === "string" ? inner : undefined;
        }
        return undefined;
    }

    /** Return a value only when it's a non-empty string; otherwise undefined. */
    private static asId(v: unknown): string | undefined {
        return typeof v === "string" && v.trim() ? v : undefined;
    }

    private async handleInbound(req: Request, res: Response): Promise<Response> {
        try {
            const body = req.body ?? {};

            const contactId: string | undefined = body.contactId ?? body.contact_id ?? body.userId;

            // GHL's real inbound payload delivers the message as an OBJECT
            // (`{ type, body }`), not a string. Unwrap it (and the alternate `body`
            // field) to the underlying text before anything tries to parse it.
            const message: string | undefined =
                JakeSmsResource.asText(body.message) ??
                JakeSmsResource.asText(body.body) ??
                JakeSmsResource.asText(body.text);

            // The SENDER's number — the person who texted in. This is the billing
            // identity in BOTH modes. GHL webhooks vary, so accept the common shapes.
            const senderPhone: string | undefined =
                body.from ?? body.fromNumber ?? body.from_number ?? body.phone;

            // Routing keys for own_number resolution: the sub-account id and the
            // destination number the text was received on (the tenant's own number).
            // GHL may send the location as a top-level id, a nested `location`
            // object (`{ id }`), a bare `location` string, or under `customData`.
            // OPTIONAL — a missing id is fine; the shared gateway mode works without
            // it, so we must never let an absent locationId break the flow.
            const location = body.location;
            const locationId: string | undefined =
                JakeSmsResource.asId(body.locationId) ??
                JakeSmsResource.asId(body.location_id) ??
                (location && typeof location === "object"
                    ? JakeSmsResource.asId((location as { id?: unknown }).id)
                    : JakeSmsResource.asId(location)) ??
                JakeSmsResource.asId(body.customData?.locationId);
            const toNumber: string | undefined = body.to ?? body.toNumber ?? body.to_number;

            // Operational logging for inbound diagnosis (JAK-127). Runs only after
            // the MASTER_API_KEY check has passed, so we never log unauthenticated
            // spam. Surfaces exactly what GHL POSTs — the field KEYS present plus
            // the resolved values we route on — so we can catch cases like an
            // unresolved {{message.body}} token arriving empty. NEVER logs the
            // master api key or any header secret: only request-body fields.
            console.log("JAK inbound", {
                bodyKeys: Object.keys(body),
                from: senderPhone,
                contactId,
                message: message && String(message).trim() ? message : "(empty)",
                locationId,
                parsedAddress: normalizeInboundAddress(message),
            });

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
