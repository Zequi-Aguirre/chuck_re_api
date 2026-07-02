import { injectable } from "tsyringe";
import { PostgresDatabase } from "../../data/PostgresDatabase";
import { CreditChargeLine, CreditLedgerReason } from "./CreditCosts";

/**
 * Raw persistence row for the `credit_ledger` table (JAK-109). One row per debit
 * or credit; `amount` is signed (negative = charge, positive = grant/refund).
 */
export interface CreditLedgerRow {
  id: string;
  location_id: string;
  amount: number;
  balance_after: number;
  reason: string;
  contact_id: string | null;
  created_at: Date;
  modified_at: Date;
  deleted_at: Date | null;
}

/** Result of an atomic charge attempt. */
export type ChargeResult =
  | { ok: true; balanceAfter: number; entries: CreditLedgerRow[] }
  | { ok: false; balance: number; required: number };

/**
 * Data-access layer for credit metering (JAK-109).
 *
 * Pure SQL over {@link PostgresDatabase}, mirroring the JAK-102/JAK-105 stores:
 * snake_case columns, timestamptz timestamps, lazy pool. It owns the ONE piece
 * of real concurrency in this module — deducting credits without overdrawing —
 * by doing the read-check-write inside a transaction with a row lock
 * (`SELECT ... FOR UPDATE` on the maintained `credit_balances` row), then
 * appending the ledger entries in the SAME transaction so the balance and the
 * ledger can never diverge.
 */
@injectable()
export class CreditLedgerStore {
  constructor(private readonly db: PostgresDatabase) {}

  /** Current spendable balance for a location (0 if it has none yet). */
  async getBalance(locationId: string): Promise<number> {
    const result = await this.db.query<{ balance: number }>(
      `SELECT balance FROM credit_balances WHERE location_id = $1`,
      [locationId]
    );
    return result.rows[0]?.balance ?? 0;
  }

  /** Most recent ledger entries for a location, newest first (excludes voided). */
  async recentEntries(locationId: string, limit = 20): Promise<CreditLedgerRow[]> {
    const result = await this.db.query<CreditLedgerRow>(
      `SELECT * FROM credit_ledger
       WHERE location_id = $1 AND deleted_at IS NULL
       ORDER BY created_at DESC, id DESC
       LIMIT $2`,
      [locationId, limit]
    );
    return result.rows;
  }

  /**
   * Deduct credits atomically. Locks the location's balance row, verifies it can
   * cover the total of `lines`, then writes the new balance and one ledger row
   * per line — all in one transaction. If the balance can't cover the total,
   * NOTHING is written (no half-charge) and `{ ok: false }` is returned.
   *
   * Each line's positive `amount` is recorded as a negative ledger `amount`.
   */
  async charge(input: {
    locationId: string;
    contactId?: string | null;
    lines: CreditChargeLine[];
  }): Promise<ChargeResult> {
    const required = input.lines.reduce((sum, line) => sum + line.amount, 0);
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");

      // Ensure a balance row exists, then lock it for the rest of the txn.
      await client.query(
        `INSERT INTO credit_balances (location_id) VALUES ($1)
         ON CONFLICT (location_id) DO NOTHING`,
        [input.locationId]
      );
      const locked = await client.query<{ balance: number }>(
        `SELECT balance FROM credit_balances WHERE location_id = $1 FOR UPDATE`,
        [input.locationId]
      );
      const balance = locked.rows[0]?.balance ?? 0;

      if (balance < required) {
        await client.query("ROLLBACK");
        return { ok: false, balance, required };
      }

      const balanceAfter = balance - required;
      await client.query(
        `UPDATE credit_balances SET balance = $2, modified_at = now()
         WHERE location_id = $1`,
        [input.locationId, balanceAfter]
      );

      // One ledger row per priced line, each snapshotting the running balance so
      // the sequence reconstructs exactly.
      const entries: CreditLedgerRow[] = [];
      let running = balance;
      for (const line of input.lines) {
        running -= line.amount;
        const inserted = await client.query<CreditLedgerRow>(
          `INSERT INTO credit_ledger
             (location_id, amount, balance_after, reason, contact_id)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING *`,
          [input.locationId, -line.amount, running, line.reason, input.contactId ?? null]
        );
        entries.push(inserted.rows[0]);
      }

      await client.query("COMMIT");
      return { ok: true, balanceAfter, entries };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Add credits atomically (beta manual grant / refund / adjustment). Locks the
   * balance row, increments it, and appends one positive ledger row. Returns the
   * created entry.
   */
  async grant(input: {
    locationId: string;
    amount: number;
    reason: CreditLedgerReason;
    contactId?: string | null;
  }): Promise<CreditLedgerRow> {
    if (!Number.isInteger(input.amount) || input.amount <= 0) {
      throw new Error("grant amount must be a positive integer");
    }
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO credit_balances (location_id) VALUES ($1)
         ON CONFLICT (location_id) DO NOTHING`,
        [input.locationId]
      );
      const locked = await client.query<{ balance: number }>(
        `SELECT balance FROM credit_balances WHERE location_id = $1 FOR UPDATE`,
        [input.locationId]
      );
      const balanceAfter = (locked.rows[0]?.balance ?? 0) + input.amount;
      await client.query(
        `UPDATE credit_balances SET balance = $2, modified_at = now()
         WHERE location_id = $1`,
        [input.locationId, balanceAfter]
      );
      const inserted = await client.query<CreditLedgerRow>(
        `INSERT INTO credit_ledger
           (location_id, amount, balance_after, reason, contact_id)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [input.locationId, input.amount, balanceAfter, input.reason, input.contactId ?? null]
      );
      await client.query("COMMIT");
      return inserted.rows[0];
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
}
