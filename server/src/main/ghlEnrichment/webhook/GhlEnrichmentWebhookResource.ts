import express, { Request, Response, Router } from "express";
import { inject, injectable } from "tsyringe";
import { LeadEnrichmentQueueService } from "../../services/LeadEnrichmentQueueService";
import { GhlConnectionService } from "../connections/GhlConnectionService";
import { GhlWebhookVerifier } from "./GhlWebhookVerifier";
import {
  ParsedContactWebhook,
  RawGhlWebhookBody,
  SUPPORTED_EVENT_TYPE,
} from "./GhlWebhookTypes";

/**
 * Inbound GHL `ContactCreate` webhook receiver (JAK-106).
 *
 * One endpoint — `POST /webhooks/ghl` — that GHL calls when a new contact is
 * created in an installed sub-account. It does the least possible synchronously
 * so the response is fast, and hands the real work to the enrichment worker
 * (JAK-107) via the queue:
 *
 *   1. Verify the webhook signature ({@link GhlWebhookVerifier}) — the shared
 *      GHL_WEBHOOK_SECRET, NOT the MASTER_API_KEY (that guards the text path).
 *   2. Validate the payload (location id + contact id present).
 *   3. Resolve the location from the JAK-102 connection store; drop it if the
 *      location is unknown or inactive (uninstalled).
 *   4. ENQUEUE an enrichment job on the reused BullMQ queue — never enrich inline.
 *
 * Idempotent: the BullMQ job id is derived from `location:contact`, so GHL's
 * webhook retries (or duplicate deliveries) collapse onto the same job instead
 * of double-enqueuing. Enrichment itself (loading the contact, running the Jake
 * engine, write-back) is JAK-107 — this endpoint only enqueues.
 *
 * It REUSES the parked MVP queue plumbing ({@link LeadEnrichmentQueueService} →
 * BullMQ/Redis) rather than standing up a second queue.
 */
@injectable()
export class GhlEnrichmentWebhookResource {
  public readonly router: Router;

  constructor(
    private readonly verifier: GhlWebhookVerifier,
    @inject(GhlConnectionService) private readonly connections: GhlConnectionService,
    @inject(LeadEnrichmentQueueService) private readonly queue: LeadEnrichmentQueueService
  ) {
    this.router = Router();
    this.configureRoutes();
  }

  private configureRoutes(): void {
    // Capture the RAW body so signature verification hashes the exact bytes GHL
    // signed (re-serialized JSON would not match). This route-scoped parser runs
    // before the app-wide express.json(), which then no-ops for this path.
    this.router.post(
      "/",
      express.json({
        verify: (req, _res, buf) => {
          (req as Request & { rawBody?: Buffer }).rawBody = buf;
        },
      }),
      this.handleWebhook.bind(this)
    );
  }

  private async handleWebhook(req: Request, res: Response): Promise<Response> {
    try {
      // 1. Authenticate. The signature is over the raw body; reject if we can't
      //    verify it. (unverified-dev is only ever returned off-prod.)
      const rawBody =
        (req as Request & { rawBody?: Buffer }).rawBody ?? Buffer.from("");
      const signature = this.readSignatureHeader(req);
      const verification = this.verifier.verify(rawBody, signature);
      if (verification === "missing-signature" || verification === "invalid-signature") {
        console.warn(`🔒 Rejected GHL webhook: ${verification}`);
        return res.status(401).json({ error: "invalid signature" });
      }

      // 2. Validate the payload.
      const parsed = this.parse(req.body as RawGhlWebhookBody);
      if (!parsed) {
        return res.status(400).json({ error: "missing location or contact id" });
      }

      // Only ContactCreate is acted on for the MVP. ContactUpdate (and any other
      // event) is acknowledged and dropped so GHL doesn't retry it.
      if (parsed.type !== SUPPORTED_EVENT_TYPE) {
        return res
          .status(200)
          .json({ status: "ignored", reason: `unsupported event ${parsed.type}` });
      }

      // 3. Resolve the location. Unknown or inactive (uninstalled) → acknowledge
      //    and drop; we return 200 so GHL stops retrying a location we won't process.
      const connection = await this.connections.getByLocationId(parsed.locationId);
      if (!connection) {
        console.warn(`❔ GHL webhook for unknown location ${parsed.locationId} — ignored`);
        return res.status(200).json({ status: "ignored", reason: "unknown location" });
      }
      if (connection.status !== "active") {
        console.warn(
          `💤 GHL webhook for inactive location ${parsed.locationId} — ignored`
        );
        return res.status(200).json({ status: "ignored", reason: "location inactive" });
      }

      // 4. Enqueue. The deterministic job id makes retries idempotent — a repeat
      //    delivery for the same contact collapses onto the existing job.
      const jobId = this.jobId(parsed.locationId, parsed.contactId);
      await this.queue.enqueue(
        {
          contact_id: parsed.contactId,
          location_id: parsed.locationId,
          ...(parsed.fullAddress ? { full_address: parsed.fullAddress } : {}),
        },
        { jobId }
      );

      return res.status(202).json({ status: "queued", jobId });
    } catch (err) {
      console.error("❌ Error in GHL enrichment webhook handler:", err);
      return res.status(500).json({ error: "Internal Server Error" });
    }
  }

  /** GHL signs with `x-wh-signature`; accept the generic `x-ghl-signature` too. */
  private readSignatureHeader(req: Request): string | undefined {
    const header = req.headers["x-wh-signature"] ?? req.headers["x-ghl-signature"];
    return Array.isArray(header) ? header[0] : header;
  }

  /**
   * Pull the routing fields out of a raw GHL body, tolerating the id/casing
   * variants GHL uses. Returns null if we can't identify both a location and a
   * contact — there's nothing to enqueue without them.
   */
  private parse(body: RawGhlWebhookBody | undefined): ParsedContactWebhook | null {
    if (!body) return null;

    const locationId = (body.locationId ?? body.location_id ?? "").trim();
    const contactId = (body.contactId ?? body.contact_id ?? body.id ?? "").trim();
    if (!locationId || !contactId) return null;

    return {
      // GHL omits `type` on some custom-webhook configs; default to ContactCreate.
      type: (body.type ?? SUPPORTED_EVENT_TYPE).trim(),
      locationId,
      contactId,
      fullAddress: this.buildFullAddress(body),
    };
  }

  /** Best-effort single-line address from the payload; undefined if none present. */
  private buildFullAddress(body: RawGhlWebhookBody): string | undefined {
    const parts = [
      body.address1,
      body.city,
      body.state,
      body.postalCode ?? body.postal_code,
    ]
      .map((p) => (typeof p === "string" ? p.trim() : ""))
      .filter((p) => p.length > 0);
    return parts.length > 0 ? parts.join(", ") : undefined;
  }

  /** Deterministic BullMQ job id → duplicate deliveries dedupe onto one job. */
  private jobId(locationId: string, contactId: string): string {
    return `ghl:${locationId}:${contactId}`;
  }
}
