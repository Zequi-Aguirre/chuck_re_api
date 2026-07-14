import { NextFunction, Request, Response, Router } from "express";
import { inject, injectable } from "tsyringe";
import { EnvConfig } from "../../config/envConfig";
import { AdminAuthService } from "./AdminAuthService";
import { ADMIN_COOKIE, requireAdminAuth } from "./requireAdminAuth";

/**
 * Admin authentication endpoints (JAK-113).
 *
 *   POST /login   — email + password → sets the httpOnly session cookie.
 *   POST /logout  — clears the session cookie.
 *   GET  /me      — the current admin (guarded); how the SPA checks its session.
 *
 * SECURITY:
 *  - The session JWT is delivered as an httpOnly, sameSite=lax cookie (secure in
 *    prod) so browser JS can't read it (XSS token theft) and it isn't kept in
 *    localStorage. {@link AdminAuthService} owns bcrypt verify + signing.
 *  - Login failures are a single generic 401 — the response never says whether
 *    the email or the password was wrong (no account enumeration).
 *  - No password or token is ever logged.
 */
@injectable()
export class AdminAuthResource {
  public readonly router: Router;

  constructor(
    @inject(AdminAuthService) private readonly auth: AdminAuthService,
    @inject(EnvConfig) private readonly env: EnvConfig
  ) {
    this.router = Router();
    this.configureRoutes();
  }

  private configureRoutes(): void {
    this.router.post("/login", this.login.bind(this));
    this.router.post("/logout", this.logout.bind(this));
    this.router.get("/me", requireAdminAuth(this.auth), this.me.bind(this));
  }

  private async login(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const email = typeof req.body?.email === "string" ? req.body.email : "";
      const password = typeof req.body?.password === "string" ? req.body.password : "";
      if (!email.trim() || !password) {
        return res.status(400).json({ error: "Email and password are required" });
      }

      const user = await this.auth.verifyCredentials(email, password);
      if (!user) {
        return res.status(401).json({ error: "Invalid email or password" });
      }

      const token = this.auth.issueToken(user);
      res.cookie(ADMIN_COOKIE, token, this.cookieOptions());
      return res.status(200).json({ user: { id: user.id, email: user.email, role: user.role } });
    } catch (err) {
      return next(err);
    }
  }

  private logout(_req: Request, res: Response): Response {
    res.clearCookie(ADMIN_COOKIE, { ...this.cookieOptions(), maxAge: undefined });
    return res.status(200).json({ ok: true });
  }

  private me(req: Request, res: Response): Response {
    return res.status(200).json({
      // role (JAK-125) tells the SPA whether to show the superadmin-only Admins
      // tab. The value comes from the verified session, not client input.
      user: { id: req.admin?.sub, email: req.admin?.email, role: req.admin?.role },
    });
  }

  /** Cookie flags: httpOnly always; secure + longer-lived only makes sense in prod. */
  private cookieOptions() {
    return {
      httpOnly: true,
      sameSite: "lax" as const,
      secure: this.env.isProduction,
      maxAge: this.auth.sessionTtlSeconds * 1000,
      path: "/",
    };
  }
}
