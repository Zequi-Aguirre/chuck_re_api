/**
 * Inbound "contact created" webhook receiver for auto-enrichment (JAK-182, epic
 * JAK-180).
 *
 * One endpoint — `POST /ghl/contact-created` — that a GHL WORKFLOW automation POSTs
 * to when a new contact is created in an installed sub-account. It does the least
 * possible synchronously so GHL's workflow is never blocked, and hands the real
 * work to the enrichment worker (JAK-183) via the JAK-181 queue:
 *
 *   1. Authenticate — the app-level MASTER_API_KEY header, mirroring the text-Jake
 *      inbound SMS route ({@link import("../../resources/JakeSmsResource")}). A GHL
 *      workflow custom-webhook action can send this header; it's an app secret in
 *      Doppler, NOT a GHL/tenant credential.
 *   2. Validate + normalize — require a location id + contact id (400 otherwise);
 *      normalize GHL's flexible field names to a clean shape.
 *   3. Resolve the location via the JAK-102 connection store. Unknown / inactive /
 *      not-yet-enabled → 200 ACK but SKIP enqueue, so GHL's workflow never errors.
 *   4. Enqueue on {@link AutoEnrichmentQueueService} and return 200 immediately.
 *      Dedupe (jobId = contactId) is handled inside the queue.
 *
 * The REAPI lookup + custom-field write-back are the worker's job (JAK-183) — this
 * endpoint only enqueues.
 */
import { Router, Request, Response, NextFunction } from "express";
import { inject, injectable } from "tsyringe";
import { EnvConfig } from "../../config/envConfig";
import { GhlConnectionService } from "../connections/GhlConnectionService";
import { GhlConnection } from "../connections/GhlConnectionTypes";
import { AutoEnrichmentQueueService } from "./AutoEnrichmentQueueService";
import { AutoEnrichmentJobPayload } from "./AutoEnrichmentQueueTypes";
import { ParsedContactCreated, RawContactCreatedBody } from "./ContactCreatedTypes";

@injectable()
export class ContactCreatedResource {
  public readonly router: Router;

  constructor(
    private readonly env: EnvConfig,
    @inject(GhlConnectionService) private readonly connections: GhlConnectionService,
    @inject(AutoEnrichmentQueueService) private readonly queue: AutoEnrichmentQueueService
  ) {
    this.router = Router();
    this.configureRoutes();
  }

  private configureRoutes(): void {
    this.router.post(
      "/contact-created",
      this.requireMasterApiKey.bind(this),
      this.handleContactCreated.bind(this)
    );
  }

  /**
   * Reject requests without a valid MASTER_API_KEY header. Mirrors
   * {@link import("../../resources/JakeSmsResource").JakeSmsResource} — the same
   * app secret guards every GHL-automation-POSTed transport. NOT a GHL/tenant key.
   */
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

  private async handleContactCreated(req: Request, res: Response): Promise<Response> {
    try {
      // 1. Validate + normalize. Missing routing ids → 400 (nothing to enqueue).
      const parsed = this.parse(req.body as RawContactCreatedBody | undefined);
      if (!parsed) {
        return res
          .status(400)
          .json({ status: "rejected", error: "missing locationId or contactId" });
      }

      // 2. Resolve the location. Unknown / inactive / not-enabled → 200 ACK +
      //    skip, so GHL's workflow doesn't error or retry a location we won't
      //    process. We do NOT enqueue in these cases.
      const connection = await this.connections.getByLocationId(parsed.locationId);
      if (!this.isEnrichmentEnabled(connection)) {
        const reason = !connection ? "unknown location" : "enrichment not enabled";
        console.warn(
          `↩️ contact-created for location ${parsed.locationId}: ${reason} — acknowledged, not enqueued`
        );
        return res.status(200).json({ status: "skipped", reason });
      }

      // 3. Enqueue and respond immediately. The queue dedupes on contactId
      //    (jobId = contactId), so a re-fired contact collapses onto one job.
      await this.queue.enqueue(this.toJobPayload(parsed, req.body as RawContactCreatedBody));

      return res.status(200).json({ status: "queued", contactId: parsed.contactId });
    } catch (err) {
      console.error("❌ Error in contact-created webhook handler:", err);
      return res.status(500).json({ status: "error", error: "Internal Server Error" });
    }
  }

  /**
   * Whether we should enrich contacts for this location. Requires BOTH:
   *   - an active (connected, installed) sub-account, AND
   *   - the JAK-186 per-location auto-enrichment toggle turned ON (opt-in).
   *
   * When off (unknown / inactive / toggle-disabled), the caller acks 200
   * `{status:"skipped"}` without enqueuing — GHL's workflow is never errored.
   */
  private isEnrichmentEnabled(connection: GhlConnection | null): connection is GhlConnection {
    return (
      connection !== null &&
      connection.status === "active" &&
      connection.autoEnrichmentEnabled === true
    );
  }

  /**
   * Pull the routing + address fields out of a raw GHL workflow body, tolerating
   * the id/casing variants GHL uses. Returns null when either id is absent —
   * there's nothing to enqueue without both.
   */
  private parse(body: RawContactCreatedBody | undefined): ParsedContactCreated | null {
    if (!body || typeof body !== "object") return null;

    const locationId = this.str(body.locationId) ?? this.str(body.location_id);
    const contactId =
      this.str(body.contactId) ?? this.str(body.contact_id) ?? this.str(body.id);
    if (!locationId || !contactId) return null;

    const address = this.parseAddress(body);
    return { locationId, contactId, ...(address ? { address } : {}) };
  }

  /** Normalize the address parts; undefined when the payload carried none. */
  private parseAddress(body: RawContactCreatedBody): ParsedContactCreated["address"] | undefined {
    const line1 =
      this.str(body.address1) ??
      this.str(body.address) ??
      this.str(body.line1) ??
      this.str(body.street);
    const city = this.str(body.city);
    const state = this.str(body.state);
    const postal =
      this.str(body.postalCode) ??
      this.str(body.postal_code) ??
      this.str(body.postalcode) ??
      this.str(body.zip) ??
      this.str(body.zipCode);

    const address = {
      ...(line1 ? { line1 } : {}),
      ...(city ? { city } : {}),
      ...(state ? { state } : {}),
      ...(postal ? { postal } : {}),
    };
    return Object.keys(address).length > 0 ? address : undefined;
  }

  /**
   * Build the queue payload. Carries the parsed address when present; otherwise
   * attaches the raw body as `rawContact` so the worker (JAK-183) can still attempt
   * address resolution — matching the JAK-181 "address OR raw contact" contract.
   */
  private toJobPayload(
    parsed: ParsedContactCreated,
    rawBody: RawContactCreatedBody
  ): AutoEnrichmentJobPayload {
    return {
      locationId: parsed.locationId,
      contactId: parsed.contactId,
      ...(parsed.address
        ? { address: parsed.address }
        : { rawContact: { ...rawBody } }),
    };
  }

  /** A trimmed non-empty string from an unknown value, or undefined. */
  private str(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
}
