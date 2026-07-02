import { injectable } from "tsyringe";
import { PostgresDatabase } from "../../data/PostgresDatabase";

/**
 * Raw persistence row for the `ghl_custom_fields` table (JAK-105). Maps a stable
 * Jake field key to the GHL-assigned custom field id in one location, so the
 * enrichment worker (JAK-107) knows exactly which field to write back to.
 */
export interface GhlCustomFieldRow {
  id: string;
  location_id: string;
  jake_field_key: string;
  ghl_field_id: string;
  ghl_field_key: string | null;
  name: string;
  data_type: string;
  created_at: Date;
  modified_at: Date;
  deleted_at: Date | null;
}

export interface InsertGhlCustomFieldRow {
  location_id: string;
  jake_field_key: string;
  ghl_field_id: string;
  ghl_field_key: string | null;
  name: string;
  data_type: string;
}

/**
 * Data-access layer for provisioned custom fields (JAK-105).
 *
 * Pure SQL over {@link PostgresDatabase}, mirroring the JAK-102
 * {@link import("../connections/GhlConnectionStore").GhlConnectionStore}: same
 * snake_case columns, timestamptz timestamps, and lazy pool. Reads exclude
 * soft-deleted rows (`deleted_at is null`).
 */
@injectable()
export class GhlCustomFieldStore {
  constructor(private readonly db: PostgresDatabase) {}

  async insert(row: InsertGhlCustomFieldRow): Promise<GhlCustomFieldRow> {
    const result = await this.db.query<GhlCustomFieldRow>(
      `INSERT INTO ghl_custom_fields
         (location_id, jake_field_key, ghl_field_id, ghl_field_key, name, data_type)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        row.location_id,
        row.jake_field_key,
        row.ghl_field_id,
        row.ghl_field_key,
        row.name,
        row.data_type,
      ]
    );
    return result.rows[0];
  }

  /** Every field provisioned for a location (excludes soft-deleted). */
  async listByLocation(locationId: string): Promise<GhlCustomFieldRow[]> {
    const result = await this.db.query<GhlCustomFieldRow>(
      `SELECT * FROM ghl_custom_fields
       WHERE location_id = $1 AND deleted_at IS NULL
       ORDER BY created_at ASC`,
      [locationId]
    );
    return result.rows;
  }
}
