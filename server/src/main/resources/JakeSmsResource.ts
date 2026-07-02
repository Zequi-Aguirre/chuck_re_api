import { Router, Request, Response, NextFunction } from "express";
import { injectable } from "tsyringe";
import { EnvConfig } from "../config/envConfig.ts";
import { GhlConnectionService } from "../ghlEnrichment/connections/GhlConnectionService.ts";
import { GhlConnection } from "../ghlEnrichment/connections/GhlConnectionTypes.ts";
import { JakeAssistantService } from "../services/JakeAssistantService.ts";
import { JakeInboundMessage } from "../types/Jake.ts";

/**
 * Inbound SMS webhook (multi-tenant, JAK-114). A GHL automation POSTs here with
 * the inbound message + contact info; the server RESOLVES which tenant/location
 * the text belongs to, loads THAT location's credentials from the JAK-102
 * connection store (via the assistant → JAK-104 client), validates the address,
 * looks up the property, and replies over that tenant's GHL. No single Doppler
 * `GHL_API_KEY` is involved — creds are per-location.
 *
 * Two auth layers, both required:
 *  - The transport is guarded by the app-level MASTER_API_KEY header (an
 *    app-level secret Doppler still holds — NOT a tenant credential).
 *  - The *tenant* is then resolved from the payload: the GHL location id it
 *    carries, and/or the destination number the text arrived on (matched
 *    against the connection's stored phone numbers). If nothing resolves the
 *    request is ignored — no processing, no cross-tenant credential use, no
 *    crash.
 */
@injectable()
export class JakeSmsResource {
    public readonly router: Router;

    constructor(
        private readonly env: EnvConfig,
        private readonly connections: GhlConnectionService,
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

            // Tenant-routing keys the GHL inbound webhook carries. locationId is
            // the authoritative sub-account id; the destination number(s) are the
            // tenant's own GHL number(s) the text was received on.
            const locationId: string | undefined = body.locationId ?? body.location_id;
            const toNumber: string | undefined = body.toNumber ?? body.to_number ?? body.to;
            // Legacy MVP field: the location's send-from number (a tenant number).
            const fromNumber: string | undefined = body.fromNumber ?? body.from_number;

            if (!contactId || !message || !String(message).trim()) {
                return res
                    .status(400)
                    .json({ ok: false, error: "Missing required fields: contactId and message" });
            }

            // Resolve the tenant BEFORE any processing. An unknown number/location
            // resolves to nothing → we ignore it safely rather than fall back to a
            // shared/default credential (which would be a cross-tenant leak).
            const connection = await this.resolveConnection(locationId, [toNumber, fromNumber]);
            if (!connection) {
                console.warn("❔ Inbound SMS did not resolve to any known location — ignored");
                return res.status(200).json({ ok: false, ignored: true, reason: "unknown location" });
            }
            if (connection.status !== "active") {
                console.warn(
                    `💤 Inbound SMS for inactive location ${connection.locationId} — ignored`
                );
                return res.status(200).json({ ok: false, ignored: true, reason: "location inactive" });
            }

            // Only ever send back through a number PROVEN to belong to this tenant;
            // otherwise omit it and let GHL use the location's default number. This
            // stops an attacker-supplied number from steering the reply out.
            const replyFrom = [toNumber, fromNumber]
                .map((n) => (n ? String(n).trim() : ""))
                .find((n) => n.length > 0 && connection.phoneNumbers.includes(n));

            const input: JakeInboundMessage = {
                locationId: connection.locationId,
                contactId: String(contactId),
                message: String(message),
                fromNumber: replyFrom || undefined,
            };

            const result = await this.assistant.handleInboundMessage(input);
            return res.status(200).json(result);
        } catch (err) {
            console.error("❌ JakeSmsResource.handleInbound error:", err);
            return res.status(500).json({ ok: false, error: "Internal Server Error" });
        }
    }

    /**
     * Resolve the connection this inbound belongs to. Prefer the explicit GHL
     * location id; otherwise fall back to the first destination number that maps
     * to a stored connection. Returns null when nothing matches — the caller then
     * ignores the request instead of guessing a tenant.
     */
    private async resolveConnection(
        locationId: string | undefined,
        candidateNumbers: Array<string | undefined>
    ): Promise<GhlConnection | null> {
        const loc = locationId ? String(locationId).trim() : "";
        if (loc) {
            const byLocation = await this.connections.getByLocationId(loc);
            if (byLocation) return byLocation;
        }

        for (const raw of candidateNumbers) {
            const num = raw ? String(raw).trim() : "";
            if (!num) continue;
            const byPhone = await this.connections.getByPhoneNumber(num);
            if (byPhone) return byPhone;
        }

        return null;
    }
}
