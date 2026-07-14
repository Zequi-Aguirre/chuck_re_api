import { NextFunction, Request, Response } from "express";
import { AdminAuthService } from "./AdminAuthService";
import { AdminTokenPayload } from "./AdminTypes";

/** The auth cookie name for the admin session JWT. */
export const ADMIN_COOKIE = "jake_admin_session";

declare module "express-serve-static-core" {
  interface Request {
    /** Present only after {@link requireAdminAuth} has authenticated the request. */
    admin?: AdminTokenPayload;
  }
}

/**
 * Express middleware factory guarding every mutating/reading admin endpoint
 * (JAK-113). It accepts the session JWT from the httpOnly `jake_admin_session`
 * cookie (how the SPA authenticates) or an `Authorization: Bearer` header (for
 * scripts/tests), verifies it via {@link AdminAuthService}, and attaches the
 * payload to `req.admin`. Any missing/invalid/expired token is a flat 401 — it
 * never falls through to the handler.
 */
export function requireAdminAuth(auth: AdminAuthService) {
  return (req: Request, res: Response, next: NextFunction): Response | void => {
    const token = extractToken(req);
    if (!token) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const payload = auth.verifyToken(token);
    if (!payload) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    req.admin = payload;
    return next();
  };
}

/**
 * Express middleware requiring the authenticated admin to be a SUPERADMIN
 * (JAK-125). MUST be mounted AFTER {@link requireAdminAuth} so `req.admin` is
 * populated — it reads the role off the verified session and 403s anyone who
 * isn't a superadmin. Gates the admin-management surface (add/list/activate/
 * deactivate/reset-password admins); a regular admin keeps full access to
 * connections/status, which are NOT behind this guard.
 */
export function requireSuperadmin() {
  return (req: Request, res: Response, next: NextFunction): Response | void => {
    if (req.admin?.role !== "superadmin") {
      return res.status(403).json({ error: "Forbidden" });
    }
    return next();
  };
}

/** Pull the session token from the cookie first, then a Bearer header. */
function extractToken(req: Request): string | null {
  const cookieToken = (req.cookies?.[ADMIN_COOKIE] as string | undefined)?.trim();
  if (cookieToken) return cookieToken;

  const header = req.header("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}
