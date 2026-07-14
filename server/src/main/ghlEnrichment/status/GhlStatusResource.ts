import { Router, Request, Response, NextFunction } from "express";
import { inject, injectable } from "tsyringe";
import { EnvConfig } from "../../config/envConfig";
import { GhlStatusService } from "./GhlStatusService";

/**
 * Read-only status API for the enrichment app (JAK-112).
 *
 * Internal-only endpoints that surface per-location health so Zequi can see
 * what's happening — connection state, credit balance + recent ledger, enrichment
 * outcome counts + a recent list, and the JAK-111 failed / dead-lettered records
 * with their failure reason (for later inspection / requeue). The admin-dashboard
 * UI that consumes this is JAK-113; this ticket is the backend only.
 *
 *   GET /locations             — overview: every installed location + counts.
 *   GET /locations/:locationId — full health for one location.
 *
 * SECURITY:
 *  - GET only; nothing here mutates.
 *  - Protected by the MASTER_API_KEY header, matching the existing internal
 *    convention (JakeSmsResource). The shared {@link
 *    import("../../middleware/authenticator").Authenticator} defers real
 *    validation to AskZoe, so for this internal read API we validate the master
 *    key directly here — presence alone is not enough.
 *  - Responses carry only the safe {@link import("./GhlStatusTypes")} views; no
 *    decrypted credential or Bearer token is ever serialized (the service maps
 *    field-by-field and never touches `api_key_encrypted`).
 */
@injectable()
export class GhlStatusResource {
  public readonly router: Router;

  constructor(
    @inject(EnvConfig) private readonly env: EnvConfig,
    @inject(GhlStatusService) private readonly status: GhlStatusService
  ) {
    this.router = Router();
    this.configureRoutes();
  }

  private configureRoutes(): void {
    this.router.use(this.requireMasterApiKey.bind(this));
    this.router.get("/locations", this.listLocations.bind(this));
    this.router.get("/locations/:locationId", this.getLocation.bind(this));
  }

  /** Reject requests without a valid MASTER_API_KEY header (internal-only). */
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

  private async listLocations(_req: Request, res: Response): Promise<Response> {
    try {
      const locations = await this.status.listLocationStatuses();
      return res.status(200).json({ locations });
    } catch (err) {
      console.error("❌ GhlStatusResource.listLocations error:", err);
      return res.status(500).json({ error: "Internal Server Error" });
    }
  }

  private async getLocation(req: Request, res: Response): Promise<Response> {
    try {
      const locationId = (req.params.locationId ?? "").trim();
      if (!locationId) {
        return res.status(400).json({ error: "missing location id" });
      }
      const detail = await this.status.getLocationStatus(locationId);
      if (!detail) {
        return res.status(404).json({ error: "unknown location" });
      }
      return res.status(200).json(detail);
    } catch (err) {
      console.error("❌ GhlStatusResource.getLocation error:", err);
      return res.status(500).json({ error: "Internal Server Error" });
    }
  }
}
