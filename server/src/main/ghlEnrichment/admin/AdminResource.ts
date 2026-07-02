import { NextFunction, Request, Response, Router } from "express";
import { inject, injectable } from "tsyringe";
import { GhlStatusService } from "../status/GhlStatusService";
import { AdminAuthService } from "./AdminAuthService";
import { AdminConnectionService } from "./AdminConnectionService";
import { requireAdminAuth } from "./requireAdminAuth";

/**
 * The admin dashboard's data API (JAK-113) — CRUD over connected sub-accounts,
 * their status view, and manual credit grants. EVERY route is behind
 * {@link requireAdminAuth}; there is no unauthenticated path here.
 *
 *   GET    /connections                      — overview list (JAK-112 summary).
 *   POST   /connections                      — connect a sub-account (paste key).
 *   GET    /connections/:locationId          — full status detail (JAK-112).
 *   PUT    /connections/:locationId          — edit / rotate key.
 *   POST   /connections/:locationId/activate — reactivate.
 *   POST   /connections/:locationId/deactivate — inactive path (JAK-104/110).
 *   DELETE /connections/:locationId          — remove the connection.
 *   POST   /connections/:locationId/credits  — manual credit grant/adjustment.
 *
 * It REUSES the existing services — the read side is entirely JAK-112's
 * {@link GhlStatusService} (already credential-free), and the write side is the
 * thin {@link AdminConnectionService} adapter over JAK-102/104/109/110. No
 * business logic or query is reimplemented here. Responses never carry a
 * decrypted API key (create/edit return the masked view).
 */
@injectable()
export class AdminResource {
  public readonly router: Router;

  constructor(
    @inject(AdminAuthService) private readonly auth: AdminAuthService,
    @inject(AdminConnectionService) private readonly connections: AdminConnectionService,
    @inject(GhlStatusService) private readonly status: GhlStatusService
  ) {
    this.router = Router();
    this.configureRoutes();
  }

  private configureRoutes(): void {
    // Gate the whole surface — nothing here is reachable without a valid session.
    this.router.use(requireAdminAuth(this.auth));

    this.router.get("/connections", this.list.bind(this));
    this.router.post("/connections", this.create.bind(this));
    this.router.get("/connections/:locationId", this.detail.bind(this));
    this.router.put("/connections/:locationId", this.update.bind(this));
    this.router.post("/connections/:locationId/activate", this.activate.bind(this));
    this.router.post("/connections/:locationId/deactivate", this.deactivate.bind(this));
    this.router.delete("/connections/:locationId", this.remove.bind(this));
    this.router.post("/connections/:locationId/credits", this.grantCredits.bind(this));
  }

  private async list(_req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const locations = await this.status.listLocationStatuses();
      return res.status(200).json({ locations });
    } catch (err) {
      return next(err);
    }
  }

  private async create(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const locationId = str(req.body?.locationId);
      const apiKey = typeof req.body?.apiKey === "string" ? req.body.apiKey.trim() : "";
      const baseUrl = str(req.body?.baseUrl);
      const phoneNumbers = phoneList(req.body?.phoneNumbers);

      if (!locationId || !apiKey || !baseUrl) {
        return res
          .status(400)
          .json({ error: "locationId, apiKey and baseUrl are required" });
      }

      const view = await this.connections.create({ locationId, apiKey, baseUrl, phoneNumbers });
      return res.status(201).json({ connection: view });
    } catch (err) {
      return this.handleWriteError(err, res, next);
    }
  }

  private async detail(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const locationId = str(req.params.locationId);
      if (!locationId) return res.status(400).json({ error: "missing location id" });
      const detail = await this.status.getLocationStatus(locationId);
      if (!detail) return res.status(404).json({ error: "unknown location" });
      return res.status(200).json(detail);
    } catch (err) {
      return next(err);
    }
  }

  private async update(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const locationId = str(req.params.locationId);
      if (!locationId) return res.status(400).json({ error: "missing location id" });

      const apiKeyRaw = req.body?.apiKey;
      // A provided-but-empty apiKey is a client mistake, not "keep the key" —
      // undefined means keep; a blank string is rejected.
      if (apiKeyRaw !== undefined && String(apiKeyRaw).trim() === "") {
        return res.status(400).json({ error: "apiKey cannot be blank" });
      }

      const view = await this.connections.update(locationId, {
        apiKey: apiKeyRaw !== undefined ? String(apiKeyRaw).trim() : undefined,
        baseUrl: req.body?.baseUrl !== undefined ? str(req.body.baseUrl) : undefined,
        phoneNumbers:
          req.body?.phoneNumbers !== undefined ? phoneList(req.body.phoneNumbers) : undefined,
      });
      if (!view) return res.status(404).json({ error: "unknown location" });
      return res.status(200).json({ connection: view });
    } catch (err) {
      return next(err);
    }
  }

  private async activate(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const locationId = str(req.params.locationId);
      const view = await this.connections.activate(locationId);
      if (!view) return res.status(404).json({ error: "unknown location" });
      return res.status(200).json({ connection: view });
    } catch (err) {
      return next(err);
    }
  }

  private async deactivate(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const locationId = str(req.params.locationId);
      const ok = await this.connections.deactivate(locationId);
      if (!ok) return res.status(404).json({ error: "unknown location" });
      return res.status(200).json({ ok: true });
    } catch (err) {
      return next(err);
    }
  }

  private async remove(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const locationId = str(req.params.locationId);
      const ok = await this.connections.delete(locationId);
      if (!ok) return res.status(404).json({ error: "unknown location" });
      return res.status(200).json({ ok: true });
    } catch (err) {
      return next(err);
    }
  }

  private async grantCredits(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const locationId = str(req.params.locationId);
      const amount = Number(req.body?.amount);
      if (!Number.isInteger(amount) || amount === 0) {
        return res.status(400).json({ error: "amount must be a non-zero integer" });
      }
      const reason = req.body?.reason === "adjustment" ? "adjustment" : "manual_grant";
      const entry = await this.connections.grantCredits(locationId, amount, reason);
      if (!entry) return res.status(404).json({ error: "unknown location" });
      return res.status(200).json({ balance: entry.balance_after, entry });
    } catch (err) {
      return next(err);
    }
  }

  /**
   * A duplicate location_id is a client error (that sub-account is already
   * connected), not a 500. Postgres unique-violation is code 23505.
   */
  private handleWriteError(err: unknown, res: Response, next: NextFunction): Response | void {
    if (err && typeof err === "object" && (err as { code?: string }).code === "23505") {
      return res.status(409).json({ error: "That location is already connected" });
    }
    return next(err);
  }
}

/** Coerce an unknown to a trimmed string ("" for non-strings). */
function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Normalize a phone-numbers input into a clean string[] (drops blanks). */
function phoneList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => (typeof v === "string" ? v.trim() : ""))
    .filter((v) => v.length > 0);
}
