import { randomBytes } from "crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { injectable } from "tsyringe";
import { EnvConfig } from "../../config/envConfig";
import { AdminUserStore } from "./AdminUserStore";
import { AdminRole, AdminTokenPayload, AdminUser, AdminUserRow, AdminUserView } from "./AdminTypes";

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
    // A disabled admin (JAK-124) still pays the bcrypt cost above, then fails
    // like a wrong password — no separate "account disabled" signal to probe.
    if (!ok || !row.is_active) return null;
    return toAdminUser(row);
  }

  /** Mint a signed session JWT for an authenticated admin. */
  issueToken(user: AdminUser): string {
    const secret = this.env.jwtSecret;
    if (!secret) {
      throw new Error("JWT_SECRET is not configured — cannot issue admin session.");
    }
    const payload: AdminTokenPayload = { sub: user.id, email: user.email, role: user.role };
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
      // Old tokens minted before JAK-125 have no role — treat them as the
      // least-privileged 'admin' so a stale session can never be superadmin.
      const role: AdminRole = decoded.role === "superadmin" ? "superadmin" : "admin";
      return { sub: String(decoded.sub), email: String(decoded.email ?? ""), role };
    } catch {
      return null;
    }
  }

  /**
   * Bootstrap the seeded admin from Doppler-provided env at boot, and GUARANTEE
   * it is a superadmin (JAK-125). Idempotent and safe to call every start:
   *  - no-ops ("skipped") unless BOTH seed vars are set;
   *  - creates the account as a `superadmin` if it doesn't exist yet ("created");
   *  - PROMOTES an existing seeded account to `superadmin` if it's still a plain
   *    admin ("promoted") — so Zequi's already-seeded staging account becomes a
   *    superadmin on the next deploy with NO manual DB surgery;
   *  - leaves it alone ("exists") if it's already a superadmin.
   *
   * It NEVER overwrites an existing password — rotate that through the app
   * (superadmin reset), not by re-seeding. Returns a short status for the boot
   * log; no credential is ever logged.
   */
  async seedFirstAdmin(): Promise<"created" | "promoted" | "exists" | "skipped"> {
    const email = this.env.adminSeedEmail.trim().toLowerCase();
    const password = this.env.adminSeedPassword;
    if (!email || !password) return "skipped";

    const existing = await this.users.findByEmail(email);
    if (existing) {
      // Promote idempotently — don't touch the password, only the role.
      if (existing.role !== "superadmin") {
        await this.users.setRoleByEmail(email, "superadmin");
        return "promoted";
      }
      return "exists";
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    await this.users.insert(email, passwordHash, "superadmin");
    return "created";
  }

  // --- Admin management (JAK-124) ------------------------------------------
  // A logged-in admin manages the other admins from the dashboard. All password
  // handling stays here so bcrypt (and its cost) live in exactly one place.

  /** Every admin as a safe, hash-free view (newest first). */
  async listAdmins(): Promise<AdminUserView[]> {
    const rows = await this.users.listAll();
    return rows.map(toAdminView);
  }

  /** True if an admin already exists with this email (case-insensitive). */
  async emailExists(email: string): Promise<boolean> {
    return (await this.users.findByEmail(email)) !== null;
  }

  /**
   * Create a new admin from a chosen email + password. Hashes the password with
   * the SAME bcrypt cost as the seed path ({@link BCRYPT_ROUNDS}); the plaintext
   * is discarded immediately and never logged. Role defaults to 'admin'; only a
   * superadmin reaches this path (enforced at the resource layer) and may pass
   * 'superadmin'. Returns the safe view (no hash). Duplicate email is enforced
   * by the store's unique constraint as a backstop.
   */
  async createAdmin(
    email: string,
    password: string,
    role: AdminRole = "admin"
  ): Promise<AdminUserView> {
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const row = await this.users.insert(email, passwordHash, role);
    return toAdminView(row);
  }

  /** Enable/disable an admin. Returns the safe view, or null if id is unknown. */
  async setAdminActive(id: string, isActive: boolean): Promise<AdminUserView | null> {
    const row = await this.users.setActive(id, isActive);
    return row ? toAdminView(row) : null;
  }

  /**
   * Reset an admin's password to a superadmin-chosen value (JAK-125). Hashes it
   * with the SAME bcrypt cost as create/seed, then REPLACES the stored hash; the
   * plaintext is discarded immediately and never logged. There is no email,
   * reset link, or token — the superadmin hands the new password over directly.
   * Returns the safe view, or null if the id is unknown.
   */
  async resetAdminPassword(id: string, password: string): Promise<AdminUserView | null> {
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const row = await this.users.setPassword(id, passwordHash);
    return row ? toAdminView(row) : null;
  }
}

/** Map a raw row to the safe identity — drops `password_hash`. */
function toAdminUser(row: AdminUserRow): AdminUser {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Map a raw row to the safe management view — drops `password_hash`. */
function toAdminView(row: AdminUserRow): AdminUserView {
  return {
    id: row.id,
    email: row.email,
    isActive: row.is_active,
    role: row.role,
    createdAt: row.created_at,
  };
}
