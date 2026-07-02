import { randomBytes } from "crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { injectable } from "tsyringe";
import { EnvConfig } from "../../config/envConfig";
import { AdminUserStore } from "./AdminUserStore";
import { AdminTokenPayload, AdminUser, AdminUserRow } from "./AdminTypes";

/** bcrypt work factor. 12 is a sane 2020s default for an interactive login. */
const BCRYPT_ROUNDS = 12;

/**
 * Admin authentication for the dashboard (JAK-113).
 *
 * Owns the whole password + session story so no other layer touches plaintext:
 *  - Passwords are hashed with bcrypt ({@link BCRYPT_ROUNDS}); the store only
 *    ever persists the hash. Plaintext is compared with `bcrypt.compare` and
 *    then discarded — it is never stored, never logged, never reversible.
 *  - A successful login mints a short-lived JWT signed with the app `JWT_SECRET`
 *    (Doppler). {@link import("./requireAdminAuth").requireAdminAuth} verifies it.
 *  - The FIRST admin is bootstrapped from `ADMIN_SEED_EMAIL` / `ADMIN_SEED_PASSWORD`
 *    (Doppler) at boot — there is no hardcoded credential anywhere in code.
 */
@injectable()
export class AdminAuthService {
  /**
   * A real bcrypt hash of random bytes, used ONLY as the compare target when the
   * email is unknown — so a missing account does the same work as a wrong
   * password (no timing oracle for account enumeration). Not a credential.
   */
  private readonly dummyHash = bcrypt.hashSync(randomBytes(16).toString("hex"), BCRYPT_ROUNDS);

  constructor(
    private readonly users: AdminUserStore,
    private readonly env: EnvConfig
  ) {}

  /**
   * Verify an email + password. Returns the admin on success, null on any
   * failure (unknown email OR bad password — the caller must not distinguish the
   * two, to avoid leaking which emails exist). A dummy compare runs even when the
   * email is unknown so the response time doesn't reveal account existence.
   */
  async verifyCredentials(email: string, password: string): Promise<AdminUser | null> {
    const row = await this.users.findByEmail(email);
    if (!row) {
      // Constant-work path: still run a real bcrypt compare against a throwaway
      // hash so a missing account isn't faster (timing) than a wrong password.
      await bcrypt.compare(password, this.dummyHash);
      return null;
    }
    const ok = await bcrypt.compare(password, row.password_hash);
    return ok ? toAdminUser(row) : null;
  }

  /** Mint a signed session JWT for an authenticated admin. */
  issueToken(user: AdminUser): string {
    const secret = this.env.jwtSecret;
    if (!secret) {
      throw new Error("JWT_SECRET is not configured — cannot issue admin session.");
    }
    const payload: AdminTokenPayload = { sub: user.id, email: user.email };
    return jwt.sign(payload, secret, {
      expiresIn: `${this.env.adminSessionTtlHours}h`,
    });
  }

  /** Session lifetime in seconds — for the auth cookie's Max-Age. */
  get sessionTtlSeconds(): number {
    return this.env.adminSessionTtlHours * 60 * 60;
  }

  /** Verify a session JWT. Returns the payload, or null if invalid/expired. */
  verifyToken(token: string): AdminTokenPayload | null {
    const secret = this.env.jwtSecret;
    if (!secret) return null;
    try {
      const decoded = jwt.verify(token, secret);
      if (typeof decoded === "string" || !decoded.sub) return null;
      return { sub: String(decoded.sub), email: String(decoded.email ?? "") };
    } catch {
      return null;
    }
  }

  /**
   * Bootstrap the first admin from Doppler-provided env at boot. Idempotent and
   * safe to call every start: it no-ops unless BOTH seed vars are set AND no
   * admin with that email exists yet. Never overwrites an existing password —
   * rotate that through the app, not by re-seeding. Returns a short status for
   * the boot log (no credential is ever logged).
   */
  async seedFirstAdmin(): Promise<"created" | "exists" | "skipped"> {
    const email = this.env.adminSeedEmail.trim().toLowerCase();
    const password = this.env.adminSeedPassword;
    if (!email || !password) return "skipped";

    const existing = await this.users.findByEmail(email);
    if (existing) return "exists";

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    await this.users.insert(email, passwordHash);
    return "created";
  }
}

/** Map a raw row to the safe identity — drops `password_hash`. */
function toAdminUser(row: AdminUserRow): AdminUser {
  return {
    id: row.id,
    email: row.email,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
