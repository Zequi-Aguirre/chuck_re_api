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
 *   GET    /admins                — list admins (JAK-124), never any password hash.
 *   POST   /admins                — create an admin from { email, password }.
 *   POST   /admins/:id/activate   — re-enable a disabled admin.
 *   POST   /admins/:id/deactivate — disable an admin (never your own account).
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

    // Admin management (JAK-124): a logged-in admin manages the other admins.
    this.router.get("/admins", this.listAdmins.bind(this));
    this.router.post("/admins", this.createAdmin.bind(this));
    this.router.post("/admins/:id/activate", this.activateAdmin.bind(this));
    this.router.post("/admins/:id/deactivate", this.deactivateAdmin.bind(this));
  }

  // --- Admin management (JAK-124) ------------------------------------------

  private async listAdmins(_req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      // toAdminView drops password_hash — the list NEVER carries a hash.
      const admins = await this.auth.listAdmins();
      return res.status(200).json({ admins });
    } catch (err) {
      return next(err);
    }
  }

  private async createAdmin(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const email = str(req.body?.email).toLowerCase();
      // Password is intentionally NOT trimmed or logged — it's read once, hashed
      // by AdminAuthService, then discarded.
      const password = typeof req.body?.password === "string" ? req.body.password : "";

      if (!EMAIL_RE.test(email)) {
        return res.status(400).json({ error: "A valid email is required" });
      }
      if (password.length < MIN_PASSWORD_LENGTH) {
        return res
          .status(400)
          .json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
      }
      if (await this.auth.emailExists(email)) {
        return res.status(409).json({ error: "An admin with that email already exists" });
      }

      const admin = await this.auth.createAdmin(email, password);
      return res.status(201).json({ admin });
    } catch (err) {
      // Unique-violation backstop for a race between the pre-check and insert.
      if (err && typeof err === "object" && (err as { code?: string }).code === "23505") {
        return res.status(409).json({ error: "An admin with that email already exists" });
      }
      return next(err);
    }
  }

  private async activateAdmin(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const admin = await this.auth.setAdminActive(str(req.params.id), true);
      if (!admin) return res.status(404).json({ error: "unknown admin" });
      return res.status(200).json({ admin });
    } catch (err) {
      return next(err);
    }
  }

  private async deactivateAdmin(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const id = str(req.params.id);
      // Lockout guard: an admin can never disable their own logged-in account —
      // that could lock the last operator out of the dashboard.
      if (id === req.admin?.sub) {
        return res.status(400).json({ error: "You can't deactivate your own account" });
      }
      const admin = await this.auth.setAdminActive(id, false);
      if (!admin) return res.status(404).json({ error: "unknown admin" });
      return res.status(200).json({ admin });
    } catch (err) {
      return next(err);
    }
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

/** Minimum length for an admin-chosen password (JAK-124). */
const MIN_PASSWORD_LENGTH = 8;

/** Pragmatic email shape check — a single `@` with non-empty, dot-bearing sides. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
