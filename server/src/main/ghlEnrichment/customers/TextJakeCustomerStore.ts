import { injectable } from "tsyringe";
import { PostgresDatabase } from "../../data/PostgresDatabase";
import { normalizePhone } from "./phoneNormalization";
import { TextCustomerStatus } from "./TextJakeCustomerTypes";

/**
 * Raw persistence row for `text_jake_customers` (JAK-115). One row per distinct
 * sender phone. Mirrors the other stores: snake_case columns, timestamptz
 * timestamps, lazy pool.
 */
export interface TextJakeCustomerRow {
  id: string;
  phone: string;
  ghl_contact_id: string | null;
  // Optional profile (JAK-146). Phone stays the mandatory identity; these are
  // nullable so a customer can be saved with a blank email / no name.
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  // Two-level hold state (JAK-148): 'active' | 'on_hold' | 'deactivated'. Column
  // default is 'active', so a row created before this ticket reads as active.
  status: TextCustomerStatus;
  created_at: Date;
  modified_at: Date;
  deleted_at: Date | null;
}

/** The editable profile fields on a text-Jake customer (JAK-146). */
export interface TextJakeCustomerProfile {
  firstName: string | null;
  lastName: string | null;
  email: string | null;
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
   *
   * Returns `created: true` ONLY when this call inserted a brand-new row (via the
   * `xmax = 0` system-column trick — 0 for a fresh insert, non-zero for the ON
   * CONFLICT update). That flag is how the caller seeds a new customer's three
   * credit balances (JAK-161) exactly once, keeping the hot inbound path off the
   * seeding queries for every returning texter.
   */
  async upsertByPhone(
    phone: string,
    ghlContactId: string | null
  ): Promise<{ row: TextJakeCustomerRow; created: boolean }> {
    const result = await this.db.query<TextJakeCustomerRow & { created: boolean }>(
      `INSERT INTO text_jake_customers (phone, ghl_contact_id)
       VALUES ($1, $2)
       ON CONFLICT (phone) DO UPDATE SET
         ghl_contact_id = COALESCE(text_jake_customers.ghl_contact_id, EXCLUDED.ghl_contact_id),
         modified_at = now()
       RETURNING *, (xmax = 0) AS created`,
      // Canonicalize here too (JAK-dedup-customers) so NO create/lookup path can
      // persist an un-normalized phone and re-open the duplicate-row bug. Idempotent.
      [normalizePhone(phone), ghlContactId]
    );
    const { created, ...row } = result.rows[0];
    return { row: row as TextJakeCustomerRow, created };
  }

  /**
   * Create a text-Jake customer from the admin dashboard (JAK-146), with an
   * optional name + email captured up front. Phone is the required, unique
   * identity — a duplicate raises Postgres 23505, which the resource maps to a
   * 409. Distinct from {@link upsertByPhone}, the passive first-contact path.
   */
  async create(
    phone: string,
    profile: TextJakeCustomerProfile
  ): Promise<TextJakeCustomerRow> {
    const result = await this.db.query<TextJakeCustomerRow>(
      `INSERT INTO text_jake_customers (phone, first_name, last_name, email)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [normalizePhone(phone), profile.firstName, profile.lastName, profile.email]
    );
    return result.rows[0];
  }

  /**
   * Update a customer's phone + profile from the admin dashboard (JAK-146).
   * Returns the updated row, or null if no live customer has that id. Phone stays
   * required and unique — changing it to another customer's number raises 23505.
   */
  async updateProfile(
    id: string,
    phone: string,
    profile: TextJakeCustomerProfile
  ): Promise<TextJakeCustomerRow | null> {
    const result = await this.db.query<TextJakeCustomerRow>(
      `UPDATE text_jake_customers
       SET phone = $2,
           first_name = $3,
           last_name = $4,
           email = $5,
           modified_at = now()
       WHERE id = $1 AND deleted_at IS NULL
       RETURNING *`,
      [id, normalizePhone(phone), profile.firstName, profile.lastName, profile.email]
    );
    return result.rows[0] ?? null;
  }

  /**
   * Record the GHL contact id resolved when syncing a customer to the Jake
   * sub-account (JAK-147). Returns the updated row, or null if no live customer
   * has that id. Kept separate from the profile write so a sync can persist the
   * link without re-touching the admin-entered fields.
   */
  async setGhlContactId(
    id: string,
    ghlContactId: string
  ): Promise<TextJakeCustomerRow | null> {
    const result = await this.db.query<TextJakeCustomerRow>(
      `UPDATE text_jake_customers
       SET ghl_contact_id = $2,
           modified_at = now()
       WHERE id = $1 AND deleted_at IS NULL
       RETURNING *`,
      [id, ghlContactId]
    );
    return result.rows[0] ?? null;
  }

  /**
   * Set a customer's two-level hold status (JAK-148): 'active' | 'on_hold' |
   * 'deactivated'. Returns the updated row, or null if no live customer has that
   * id. Deliberately touches ONLY `status` (+ `modified_at`) — it never reads or
   * writes the credit ledger, so a hold/deactivate/reactivate can NEVER move a
   * balance. The GHL "text Jake" field flip (deactivate/reactivate) is a separate
   * step the admin service runs through the JAK-147 sync.
   */
  async setStatus(
    id: string,
    status: TextCustomerStatus
  ): Promise<TextJakeCustomerRow | null> {
    const result = await this.db.query<TextJakeCustomerRow>(
      `UPDATE text_jake_customers
       SET status = $2,
           modified_at = now()
       WHERE id = $1 AND deleted_at IS NULL
       RETURNING *`,
      [id, status]
    );
    return result.rows[0] ?? null;
  }

  /** Look up a customer by phone without creating one. Canonicalizes the input so
   * a lookup matches regardless of the format it's given in (JAK-dedup-customers). */
  async findByPhone(phone: string): Promise<TextJakeCustomerRow | null> {
    const result = await this.db.query<TextJakeCustomerRow>(
      `SELECT * FROM text_jake_customers WHERE phone = $1`,
      [normalizePhone(phone)]
    );
    return result.rows[0] ?? null;
  }

  /**
   * Every live text-Jake customer, newest first — the admin overview (JAK-129).
   * Excludes soft-deleted rows. The admin service joins these against a single
   * balance scan ({@link CreditLedgerStore.listBalances}) rather than a
   * per-customer balance query, mirroring the JAK-112 location overview.
   */
  async listAll(): Promise<TextJakeCustomerRow[]> {
    const result = await this.db.query<TextJakeCustomerRow>(
      `SELECT * FROM text_jake_customers
       WHERE deleted_at IS NULL
       ORDER BY created_at DESC, id DESC`
    );
    return result.rows;
  }
}
