import { injectable } from "tsyringe";
import { PostgresDatabase } from "./PostgresDatabase";

/** One row of the `app_settings` key/value store (JAK-131). */
export interface AppSettingRow {
  key: string;
  value: string;
  updated_at: Date;
  /** The admin id that last saved the value; null for the seeded default. */
  updated_by: string | null;
}

/**
 * Data-access layer for the `app_settings` key/value store (JAK-131).
 *
 * Pure SQL over {@link PostgresDatabase}. Deliberately generic — it stores plain
 * text values keyed by a string, with the last-editor admin id and an
 * `updated_at` stamp. Today it backs exactly one key: the editable STYLE/FORMAT
 * prompt for the "Jake Property Report" (JAK-130). It holds NO credential — the
 * HARD guardrails around that prompt live in code, not here.
 */
@injectable()
export class AppSettingsStore {
  constructor(private readonly db: PostgresDatabase) {}

  /** Read one setting by key. Null if it has never been set. */
  async get(key: string): Promise<AppSettingRow | null> {
    const result = await this.db.query<AppSettingRow>(
      `SELECT key, value, updated_at, updated_by FROM app_settings WHERE key = $1`,
      [key]
    );
    return result.rows[0] ?? null;
  }

  /**
   * Upsert a setting's value, recording the editing admin. Bumps `updated_at`.
   * Returns the stored row.
   */
  async set(key: string, value: string, updatedBy: string | null): Promise<AppSettingRow> {
    const result = await this.db.query<AppSettingRow>(
      `INSERT INTO app_settings (key, value, updated_by, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (key)
       DO UPDATE SET value = excluded.value,
                     updated_by = excluded.updated_by,
                     updated_at = now()
       RETURNING key, value, updated_at, updated_by`,
      [key, value, updatedBy]
    );
    return result.rows[0];
  }

  /**
   * Delete a setting so it reverts to its code default. Returns true if a row
   * was removed. Used by the "reset to default" path.
   */
  async delete(key: string): Promise<boolean> {
    const result = await this.db.query(`DELETE FROM app_settings WHERE key = $1`, [key]);
    return (result.rowCount ?? 0) > 0;
  }
}
