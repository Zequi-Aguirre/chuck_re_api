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

/** Provisioned (non-deleted) field count for a location — status view (JAK-112). */
export interface LocationFieldCount {
  location_id: string;
  count: number;
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

  /**
   * Count provisioned (non-deleted) fields per location in one grouped scan —
   * the overview list (JAK-112) reads this instead of a per-location query, and
   * it doubles as the "is this location fully provisioned?" health signal.
   */
  async countByLocationForAll(): Promise<LocationFieldCount[]> {
    const result = await this.db.query<{ location_id: string; count: string }>(
      `SELECT location_id, count(*)::int AS count
       FROM ghl_custom_fields
       WHERE deleted_at IS NULL
       GROUP BY location_id`
    );
    return result.rows.map((r) => ({
      location_id: r.location_id,
      count: Number(r.count),
    }));
  }
}
