import { injectable } from "tsyringe";
import { PostgresDatabase } from "../../data/PostgresDatabase";
import { FooterRow } from "./FooterTypes";

/**
 * Data-access layer for the admin-managed reply footers (JAK-188).
 *
 * Pure SQL over {@link PostgresDatabase}. Footers are GLOBAL (no location scope).
 * The service picks a uniformly-random ACTIVE footer from {@link listActive};
 * keeping selection in the service (not `ORDER BY random()`) makes the random /
 * fallback branch unit-testable without a DB.
 */
@injectable()
export class FooterStore {
  constructor(private readonly db: PostgresDatabase) {}

  /** Every footer, newest first — the admin list. */
  async listAll(): Promise<FooterRow[]> {
    const result = await this.db.query<FooterRow>(
      `SELECT id, text, active, created_at, updated_at
         FROM footers
        ORDER BY created_at DESC`
    );
    return result.rows;
  }

  /** Only the ACTIVE footers — the rotation pool the sender draws from. */
  async listActive(): Promise<FooterRow[]> {
    const result = await this.db.query<FooterRow>(
      `SELECT id, text, active, created_at, updated_at
         FROM footers
        WHERE active = true`
    );
    return result.rows;
  }

  /** Insert a footer. Returns the stored row. */
  async insert(text: string, active: boolean): Promise<FooterRow> {
    const result = await this.db.query<FooterRow>(
      `INSERT INTO footers (text, active)
       VALUES ($1, $2)
       RETURNING id, text, active, created_at, updated_at`,
      [text, active]
    );
    return result.rows[0];
  }

  /**
   * Patch a footer by id. Only provided columns change; `updated_at` is bumped.
   * Returns the updated row, or null if no such footer.
   */
  async update(
    id: string,
    patch: { text?: string; active?: boolean }
  ): Promise<FooterRow | null> {
    const sets: string[] = [];
    const values: unknown[] = [];
    let i = 1;

    if (patch.text !== undefined) {
      sets.push(`text = $${i++}`);
      values.push(patch.text);
    }
    if (patch.active !== undefined) {
      sets.push(`active = $${i++}`);
      values.push(patch.active);
    }

    // Nothing to change → return the current row unchanged.
    if (sets.length === 0) {
      const current = await this.db.query<FooterRow>(
        `SELECT id, text, active, created_at, updated_at FROM footers WHERE id = $1`,
        [id]
      );
      return current.rows[0] ?? null;
    }

    sets.push(`updated_at = now()`);
    values.push(id);

    const result = await this.db.query<FooterRow>(
      `UPDATE footers SET ${sets.join(", ")}
        WHERE id = $${i}
        RETURNING id, text, active, created_at, updated_at`,
      values
    );
    return result.rows[0] ?? null;
  }

  /** Delete a footer by id. Returns true if a row was removed. */
  async delete(id: string): Promise<boolean> {
    const result = await this.db.query(`DELETE FROM footers WHERE id = $1`, [id]);
    return (result.rowCount ?? 0) > 0;
  }
}
