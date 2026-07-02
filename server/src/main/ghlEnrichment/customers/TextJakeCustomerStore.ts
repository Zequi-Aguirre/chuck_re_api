import { injectable } from "tsyringe";
import { PostgresDatabase } from "../../data/PostgresDatabase";

/**
 * Raw persistence row for `text_jake_customers` (JAK-115). One row per distinct
 * sender phone. Mirrors the other stores: snake_case columns, timestamptz
 * timestamps, lazy pool.
 */
export interface TextJakeCustomerRow {
  id: string;
  phone: string;
  ghl_contact_id: string | null;
  created_at: Date;
  modified_at: Date;
  deleted_at: Date | null;
}

/**
 * Data-access layer for text-Jake customers (JAK-115) — the tier-1 billing
 * identity keyed by phone. Pure SQL over {@link PostgresDatabase}.
 */
@injectable()
export class TextJakeCustomerStore {
  constructor(private readonly db: PostgresDatabase) {}

  /**
   * Resolve the customer for a sender phone, creating one on first contact
   * (atomic upsert). A provided `ghlContactId` is set only if we don't already
   * have one on file — we never overwrite a known contact link with a later
   * value — and `modified_at` is always bumped so "last seen" tracks activity.
   */
  async upsertByPhone(
    phone: string,
    ghlContactId: string | null
  ): Promise<TextJakeCustomerRow> {
    const result = await this.db.query<TextJakeCustomerRow>(
      `INSERT INTO text_jake_customers (phone, ghl_contact_id)
       VALUES ($1, $2)
       ON CONFLICT (phone) DO UPDATE SET
         ghl_contact_id = COALESCE(text_jake_customers.ghl_contact_id, EXCLUDED.ghl_contact_id),
         modified_at = now()
       RETURNING *`,
      [phone, ghlContactId]
    );
    return result.rows[0];
  }

  /** Look up a customer by phone without creating one. */
  async findByPhone(phone: string): Promise<TextJakeCustomerRow | null> {
    const result = await this.db.query<TextJakeCustomerRow>(
      `SELECT * FROM text_jake_customers WHERE phone = $1`,
      [phone]
    );
    return result.rows[0] ?? null;
  }
}
