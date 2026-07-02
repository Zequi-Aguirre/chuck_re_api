import { injectable } from "tsyringe";
import { PostgresDatabase } from "../../data/PostgresDatabase";
import { AdminUserRow } from "./AdminTypes";

/**
 * Data-access layer for admin dashboard users (JAK-113).
 *
 * Pure SQL over {@link PostgresDatabase}. It only ever reads/writes the bcrypt
 * `password_hash` — it never sees or produces a plaintext password (the
 * {@link import("./AdminAuthService").AdminAuthService} owns hash/verify). Email
 * is normalized to lowercase on every write and lookup so a login can't be
 * bypassed or duplicated by case.
 */
@injectable()
export class AdminUserStore {
  constructor(private readonly db: PostgresDatabase) {}

  /** Look up an admin by email (case-insensitive). Null if none. */
  async findByEmail(email: string): Promise<AdminUserRow | null> {
    const result = await this.db.query<AdminUserRow>(
      `SELECT * FROM admin_users WHERE email = $1`,
      [email.trim().toLowerCase()]
    );
    return result.rows[0] ?? null;
  }

  /** Look up an admin by id. Null if none. */
  async findById(id: string): Promise<AdminUserRow | null> {
    const result = await this.db.query<AdminUserRow>(
      `SELECT * FROM admin_users WHERE id = $1`,
      [id]
    );
    return result.rows[0] ?? null;
  }

  /** Every admin, newest first (admin-management list, JAK-124). */
  async listAll(): Promise<AdminUserRow[]> {
    const result = await this.db.query<AdminUserRow>(
      `SELECT * FROM admin_users ORDER BY created_at DESC`
    );
    return result.rows;
  }

  /** Insert a new admin with an already-hashed password. */
  async insert(email: string, passwordHash: string): Promise<AdminUserRow> {
    const result = await this.db.query<AdminUserRow>(
      `INSERT INTO admin_users (email, password_hash)
       VALUES ($1, $2)
       RETURNING *`,
      [email.trim().toLowerCase(), passwordHash]
    );
    return result.rows[0];
  }

  /**
   * Enable or disable an admin (JAK-124). Bumps `updated_at`. Returns the
   * updated row, or null if the id is unknown.
   */
  async setActive(id: string, isActive: boolean): Promise<AdminUserRow | null> {
    const result = await this.db.query<AdminUserRow>(
      `UPDATE admin_users
       SET is_active = $2, updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [id, isActive]
    );
    return result.rows[0] ?? null;
  }

  /** How many admins exist (bootstrap decision). */
  async count(): Promise<number> {
    const result = await this.db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM admin_users`
    );
    return Number(result.rows[0]?.count ?? "0");
  }
}
