/**
 * Inbound "contact created" webhook receiver for auto-enrichment (JAK-182, epic
 * JAK-180).
 *
 * One endpoint — `POST /ghl/contact-created` — that a GHL WORKFLOW automation POSTs
 * to when a new contact is created in an installed sub-account. It does the least
 * possible synchronously so GHL's workflow is never blocked, and hands the real
 * work to the enrichment worker (JAK-183) via the JAK-181 queue:
 *
 *   1. Authenticate BY PER-LOCATION WEBHOOK KEY (JAK-189) — the `x-api-key` header
 *      carries the sub-account's OWN key (from the admin UI, NOT the shared
 *      MASTER_API_KEY). We hash it and resolve the connection by that hash; no
 *      match / no key → 401. The resolved connection IS the location. (MASTER_API_KEY
 *      is still accepted as an internal override for our own testing — see
 *      {@link authenticate} — but sub-accounts never use it.)
 *   2. Validate — contact id required (400 otherwise); a body `locationId`, if
 *      present, must match the key's location (401 on mismatch). Address parsing
 *      stays tolerant.
 *   3. Gate — unknown (master path) / inactive / not-yet-enabled → 200 ACK but SKIP
 *      enqueue, so GHL's workflow never errors.
 *   4. Enqueue on {@link AutoEnrichmentQueueService} and return 200 immediately.
 *      Dedupe (jobId = contactId) is handled inside the queue.
 *
 * The REAPI lookup + custom-field write-back are the worker's job (JAK-183) — this
 * endpoint only enqueues.
 */
import { Router, Request, Response } from "express";
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
    this.router.post("/contact-created", this.handleContactCreated.bind(this));
  }

  /**
   * Resolve the authenticated connection for the request (JAK-189), or signal a
   * failure the handler turns into an HTTP status:
   *   - `{ kind: "unauthorized" }` — no key, or a key no location owns → 401.
   *   - `{ kind: "ok", connection }` — the resolved sub-account (may be null ONLY
   *     on the master-override path when the body's locationId isn't connected;
   *     the gate then acks 200 "unknown location", never a false 401).
   *
   * Primary: the per-location webhook key in `x-api-key`. Internal override: the
   * app MASTER_API_KEY (either header) resolves the location from the body's
   * `locationId` — handy for our own testing, never used by sub-accounts.
   */
  private async authenticate(
    req: Request,
    body: RawContactCreatedBody | undefined
  ): Promise<
    | { kind: "unauthorized" }
    | { kind: "ok"; connection: GhlConnection | null }
  > {
    const presented =
      this.str(req.header("x-api-key")) ?? this.str(req.header("x-master-api-key"));
    if (!presented) return { kind: "unauthorized" };

    // Internal MASTER_API_KEY override — resolve the location from the body.
    const master = this.str(this.env.masterApiKey);
    if (master && presented === master) {
      const bodyLocation = this.str(body?.locationId) ?? this.str(body?.location_id);
      if (!bodyLocation) return { kind: "unauthorized" }; // master needs a target
      return { kind: "ok", connection: await this.connections.getByLocationId(bodyLocation) };
    }

    // Per-location webhook key — the sub-account path. Hash + resolve by owner.
    const connection = await this.connections.getByWebhookKey(presented);
    if (!connection) return { kind: "unauthorized" }; // no location owns this key
    return { kind: "ok", connection };
  }

  private async handleContactCreated(req: Request, res: Response): Promise<Response> {
    try {
      const body = req.body as RawContactCreatedBody | undefined;

      // 1. Authenticate by per-location webhook key (or master override).
      const auth = await this.authenticate(req, body);
      if (auth.kind === "unauthorized") {
        return res.status(401).json({ status: "unauthorized", error: "invalid webhook key" });
      }
      const connection = auth.connection;

      // 2. Validate the payload. contactId is required; a body locationId, if
      //    present, must match the key's location (defense against a misrouted key).
      const parsed = this.parse(body);
      if (!parsed) {
        return res.status(400).json({ status: "rejected", error: "missing contactId" });
      }
      if (
        connection &&
        parsed.locationId !== undefined &&
        parsed.locationId !== connection.locationId
      ) {
        console.warn(
          `🔒 contact-created: body locationId "${parsed.locationId}" != key location "${connection.locationId}" — rejected`
        );
        return res.status(401).json({ status: "unauthorized", error: "location mismatch" });
      }

      // 3. Gate. Unknown (master path) / inactive / not-enabled → 200 ACK + skip,
      //    so GHL's workflow doesn't error or retry a location we won't process.
      if (!this.isEnrichmentEnabled(connection)) {
        const reason = !connection ? "unknown location" : "enrichment not enabled";
        console.warn(
          `↩️ contact-created for contact ${parsed.contactId}: ${reason} — acknowledged, not enqueued`
        );
        return res.status(200).json({ status: "skipped", reason });
      }

      // 4. Enqueue and respond immediately. The KEY's location is authoritative for
      //    the job (never the body). The queue dedupes on contactId (jobId=contactId).
      await this.queue.enqueue(this.toJobPayload(parsed, connection.locationId, body));

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
   * the id/casing variants GHL uses. Returns null when the contact id is absent —
   * there's nothing to enqueue without it. `locationId` is OPTIONAL (JAK-189: the
   * webhook key identifies the location; a body one is only cross-checked).
   */
  private parse(body: RawContactCreatedBody | undefined): ParsedContactCreated | null {
    if (!body || typeof body !== "object") return null;

    const contactId =
      this.str(body.contactId) ?? this.str(body.contact_id) ?? this.str(body.id);
    if (!contactId) return null;

    const locationId = this.str(body.locationId) ?? this.str(body.location_id);
    const address = this.parseAddress(body);
    return {
      contactId,
      ...(locationId ? { locationId } : {}),
      ...(address ? { address } : {}),
    };
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
   * Build the queue payload. `locationId` is the KEY's location (authoritative,
   * JAK-189) — never the body's. Carries the parsed address when present; otherwise
   * attaches the raw body as `rawContact` so the worker (JAK-183) can still attempt
   * address resolution — matching the JAK-181 "address OR raw contact" contract.
   */
  private toJobPayload(
    parsed: ParsedContactCreated,
    locationId: string,
    rawBody: RawContactCreatedBody | undefined
  ): AutoEnrichmentJobPayload {
    return {
      locationId,
      contactId: parsed.contactId,
      ...(parsed.address
        ? { address: parsed.address }
        : { rawContact: { ...(rawBody ?? {}) } }),
    };
  }

  /** A trimmed non-empty string from an unknown value, or undefined. */
  private str(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
}
