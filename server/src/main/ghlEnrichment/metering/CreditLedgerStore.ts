import { PoolClient } from "pg";
import { injectable } from "tsyringe";
import { PostgresDatabase } from "../../data/PostgresDatabase";
import {
  CreditChargeLine,
  CreditLedgerReason,
  CreditType,
  DEFAULT_CREDIT_TYPE,
} from "./CreditCosts";

/**
 * Raw persistence row for the `credit_ledger` table (JAK-109). One row per debit
 * or credit; `amount` is signed (negative = charge, positive = grant/refund).
 * `credit_type` (JAK-161) is the per-feature bucket the entry belongs to.
 */
export interface CreditLedgerRow {
  id: string;
  location_id: string;
  credit_type: string;
  amount: number;
  balance_after: number;
  reason: string;
  contact_id: string | null;
  created_at: Date;
  modified_at: Date;
  deleted_at: Date | null;
}

/** A location's maintained credit balance for ONE bucket — the all-locations read (JAK-112). */
export interface LocationBalance {
  location_id: string;
  balance: number;
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

  /**
   * Current spendable balance for a location in ONE bucket (0 if it has none
   * yet). Defaults to the REPORT bucket so pre-JAK-161 callers (GHL enrichment /
   * status) read the same balance they always did.
   */
  async getBalance(locationId: string, creditType: CreditType = DEFAULT_CREDIT_TYPE): Promise<number> {
    const result = await this.db.query<{ balance: number }>(
      `SELECT balance FROM credit_balances WHERE location_id = $1 AND credit_type = $2`,
      [locationId, creditType]
    );
    return result.rows[0]?.balance ?? 0;
  }

  /**
   * Every location's maintained balance for ONE bucket in a single scan — the
   * overview lists (JAK-112 locations, JAK-129 text customers) join this against
   * their rows so they never issue a balance query per location. Defaults to the
   * REPORT bucket, so those overviews keep showing the primary balance unchanged.
   */
  async listBalances(creditType: CreditType = DEFAULT_CREDIT_TYPE): Promise<LocationBalance[]> {
    const result = await this.db.query<{ location_id: string; balance: number }>(
      `SELECT location_id, balance FROM credit_balances WHERE credit_type = $1`,
      [creditType]
    );
    return result.rows.map((r) => ({
      location_id: r.location_id,
      balance: Number(r.balance),
    }));
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
   *
   * IDEMPOTENT per contact (JAK-111): when `contactId` is given, a charge that
   * already has an outstanding (non-refunded) debit for that contact is a no-op
   * — it returns `ok:true` with the current balance and no new entries. This is
   * what keeps a BullMQ retry from double-charging a contact whose first attempt
   * charged but then failed before recording success.
   */
  async charge(input: {
    locationId: string;
    creditType?: CreditType;
    contactId?: string | null;
    lines: CreditChargeLine[];
  }): Promise<ChargeResult> {
    const creditType = input.creditType ?? DEFAULT_CREDIT_TYPE;
    const required = input.lines.reduce((sum, line) => sum + line.amount, 0);
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");

      // Ensure the bucket's balance row exists, then lock it for the rest of the txn.
      await client.query(
        `INSERT INTO credit_balances (location_id, credit_type) VALUES ($1, $2)
         ON CONFLICT (location_id, credit_type) DO NOTHING`,
        [input.locationId, creditType]
      );
      const locked = await client.query<{ balance: number }>(
        `SELECT balance FROM credit_balances
         WHERE location_id = $1 AND credit_type = $2 FOR UPDATE`,
        [input.locationId, creditType]
      );
      const balance = locked.rows[0]?.balance ?? 0;

      // Idempotency: if this contact already carries a net debit in THIS bucket
      // (charged, not refunded), a retry must NOT charge again. Return the current
      // balance, nothing written. Checked under the lock so it's race-safe.
      if (
        input.contactId &&
        (await this.outstandingChargeNet(client, input.locationId, creditType, input.contactId)) < 0
      ) {
        await client.query("ROLLBACK");
        return { ok: true, balanceAfter: balance, entries: [] };
      }

      if (balance < required) {
        await client.query("ROLLBACK");
        return { ok: false, balance, required };
      }

      const balanceAfter = balance - required;
      await client.query(
        `UPDATE credit_balances SET balance = $3, modified_at = now()
         WHERE location_id = $1 AND credit_type = $2`,
        [input.locationId, creditType, balanceAfter]
      );

      // One ledger row per priced line, each snapshotting the running balance so
      // the sequence reconstructs exactly.
      const entries: CreditLedgerRow[] = [];
      let running = balance;
      for (const line of input.lines) {
        running -= line.amount;
        const inserted = await client.query<CreditLedgerRow>(
          `INSERT INTO credit_ledger
             (location_id, credit_type, amount, balance_after, reason, contact_id)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING *`,
          [input.locationId, creditType, -line.amount, running, line.reason, input.contactId ?? null]
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
    creditType?: CreditType;
    amount: number;
    reason: CreditLedgerReason;
    contactId?: string | null;
  }): Promise<CreditLedgerRow> {
    if (!Number.isInteger(input.amount) || input.amount <= 0) {
      throw new Error("grant amount must be a positive integer");
    }
    const creditType = input.creditType ?? DEFAULT_CREDIT_TYPE;
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO credit_balances (location_id, credit_type) VALUES ($1, $2)
         ON CONFLICT (location_id, credit_type) DO NOTHING`,
        [input.locationId, creditType]
      );
      const locked = await client.query<{ balance: number }>(
        `SELECT balance FROM credit_balances
         WHERE location_id = $1 AND credit_type = $2 FOR UPDATE`,
        [input.locationId, creditType]
      );
      const balanceAfter = (locked.rows[0]?.balance ?? 0) + input.amount;
      await client.query(
        `UPDATE credit_balances SET balance = $3, modified_at = now()
         WHERE location_id = $1 AND credit_type = $2`,
        [input.locationId, creditType, balanceAfter]
      );
      const inserted = await client.query<CreditLedgerRow>(
        `INSERT INTO credit_ledger
           (location_id, credit_type, amount, balance_after, reason, contact_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [input.locationId, creditType, input.amount, balanceAfter, input.reason, input.contactId ?? null]
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

  /**
   * Seed a bucket's OPENING balance exactly once (JAK-161 new-customer defaults).
   * Creates the `credit_balances` row for (location, bucket) if it is ABSENT and,
   * when the opening amount is positive, appends one matching audit ledger row.
   * Returns true if it seeded, false if the bucket already existed (idempotent —
   * a spent-down balance keeps its row, so it is NEVER re-seeded). Safe to call
   * on every customer-creation path; the ON CONFLICT DO NOTHING settles the race
   * so only the first caller writes.
   */
  async seedInitialBalance(input: {
    locationId: string;
    creditType: CreditType;
    amount: number;
    reason: CreditLedgerReason;
  }): Promise<boolean> {
    if (!Number.isInteger(input.amount) || input.amount < 0) {
      throw new Error("seed amount must be a non-negative integer");
    }
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      const created = await client.query(
        `INSERT INTO credit_balances (location_id, credit_type, balance)
         VALUES ($1, $2, $3)
         ON CONFLICT (location_id, credit_type) DO NOTHING`,
        [input.locationId, input.creditType, input.amount]
      );
      const seeded = (created.rowCount ?? 0) > 0;
      // Only the winner writes an audit row, and only for a non-zero opening grant
      // (the ledger never carries a zero-amount entry).
      if (seeded && input.amount > 0) {
        await client.query(
          `INSERT INTO credit_ledger
             (location_id, credit_type, amount, balance_after, reason, contact_id)
           VALUES ($1, $2, $3, $3, $4, NULL)`,
          [input.locationId, input.creditType, input.amount, input.reason]
        );
      }
      await client.query("COMMIT");
      return seeded;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Reverse the outstanding enrichment charge for a contact with a compensating
   * ledger entry (JAK-111 credit safety). Used when an enrichment that was
   * already charged ultimately fails / dead-letters: we must never bill for a
   * failed enrichment. Locks the balance, computes the net debit still owed for
   * the contact, credits it back exactly, and appends ONE positive `refund` row.
   *
   * IDEMPOTENT: if the contact carries no outstanding debit (never charged, or
   * already refunded), nothing is written and `null` is returned — so a retry or
   * a duplicate dead-letter hook can call it safely.
   */
  async refund(input: {
    locationId: string;
    creditType?: CreditType;
    contactId: string;
    reason?: CreditLedgerReason;
  }): Promise<CreditLedgerRow | null> {
    const creditType = input.creditType ?? DEFAULT_CREDIT_TYPE;
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO credit_balances (location_id, credit_type) VALUES ($1, $2)
         ON CONFLICT (location_id, credit_type) DO NOTHING`,
        [input.locationId, creditType]
      );
      const locked = await client.query<{ balance: number }>(
        `SELECT balance FROM credit_balances
         WHERE location_id = $1 AND credit_type = $2 FOR UPDATE`,
        [input.locationId, creditType]
      );
      const balance = locked.rows[0]?.balance ?? 0;

      const net = await this.outstandingChargeNet(client, input.locationId, creditType, input.contactId);
      if (net >= 0) {
        // Nothing outstanding to reverse — idempotent no-op.
        await client.query("ROLLBACK");
        return null;
      }

      const refundAmount = -net; // net is negative; reverse the exact debit.
      const balanceAfter = balance + refundAmount;
      await client.query(
        `UPDATE credit_balances SET balance = $3, modified_at = now()
         WHERE location_id = $1 AND credit_type = $2`,
        [input.locationId, creditType, balanceAfter]
      );
      const inserted = await client.query<CreditLedgerRow>(
        `INSERT INTO credit_ledger
           (location_id, credit_type, amount, balance_after, reason, contact_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [input.locationId, creditType, refundAmount, balanceAfter, input.reason ?? "refund", input.contactId]
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

  /**
   * The net (signed) credit delta still on the books for one contact: the sum of
   * every non-voided ledger row referencing it. Negative = a charge that has not
   * been refunded; 0 = never charged, or charged-and-refunded. Runs on the
   * caller's transaction client so it reads the row-locked, consistent view.
   */
  private async outstandingChargeNet(
    client: PoolClient,
    locationId: string,
    creditType: CreditType,
    contactId: string
  ): Promise<number> {
    const agg = await client.query<{ net: number }>(
      `SELECT COALESCE(SUM(amount), 0)::int AS net FROM credit_ledger
       WHERE location_id = $1 AND credit_type = $2 AND contact_id = $3 AND deleted_at IS NULL`,
      [locationId, creditType, contactId]
    );
    return Number(agg.rows[0]?.net ?? 0);
  }
}
