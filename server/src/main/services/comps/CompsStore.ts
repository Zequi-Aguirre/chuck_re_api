import { injectable } from "tsyringe";
import { PostgresDatabase } from "../../data/PostgresDatabase";
import { CompParams, CompsPendingRow, CompsRow } from "./CompsTypes";

/**
 * Data-access layer for the comps cache + the pending confirm-before-spend offer
 * (JAK-137). Pure SQL over {@link PostgresDatabase}, mirroring the JAK-136
 * {@link import("../skiptrace/SkipTraceStore").SkipTraceStore}: snake_case columns,
 * timestamptz timestamps, lazy pool, NO business rules and NO external call. The
 * free-window boundary + the pending TTL live in the service
 * ({@link import("./CompsMemoryService").CompsMemoryService}) so they stay
 * unit-testable without the wall clock.
 *
 * It holds NO credential.
 */
@injectable()
export class CompsStore {
  constructor(private readonly db: PostgresDatabase) {}

  /**
   * Snapshot a PAID comps pull so a repeat of the same target AND parameter-set
   * within the free window re-serves from here instead of calling (and charging
   * for) the API again — the SAME free re-serve rule as the JAK-136 skip-trace and
   * JAK-134 property lookup caches. `targetKey` already folds in the params.
   */
  async recordComps(input: {
    customerId: string;
    phone: string;
    messageId: string | null;
    normalizedTarget: string;
    targetKey: string;
    params: CompParams;
    compsRecord: unknown;
    reportText: string;
  }): Promise<CompsRow> {
    const result = await this.db.query<CompsRow>(
      `INSERT INTO text_jake_comps
         (customer_id, phone, message_id, normalized_target, target_key, params, comps_record, report_text)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8)
       RETURNING *`,
      [
        input.customerId,
        input.phone,
        input.messageId,
        input.normalizedTarget,
        input.targetKey,
        JSON.stringify(input.params),
        JSON.stringify(input.compsRecord ?? null),
        input.reportText,
      ]
    );
    return result.rows[0];
  }

  /**
   * The latest cached comps for (phone, target_key), newest first, REGARDLESS of
   * age — the free-window check is applied by the service so its boundary is
   * testable without the clock. Null if this phone never ran this exact request.
   */
  async latestComps(phone: string, targetKey: string): Promise<CompsRow | null> {
    const result = await this.db.query<CompsRow>(
      `SELECT * FROM text_jake_comps
       WHERE phone = $1 AND target_key = $2
       ORDER BY fetched_at DESC, id DESC
       LIMIT 1`,
      [phone, targetKey]
    );
    return result.rows[0] ?? null;
  }

  /**
   * Record (upsert) the ONE outstanding comps offer for a phone. A new offer
   * replaces any prior one, so "reply OK" always resolves to the most recent quote,
   * with its captured target + parameters + price.
   */
  async setPending(input: {
    phone: string;
    customerId: string;
    target: string;
    params: CompParams;
    credits: number;
  }): Promise<CompsPendingRow> {
    const result = await this.db.query<CompsPendingRow>(
      `INSERT INTO text_jake_comps_pending (phone, customer_id, target, params, credits, created_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, now())
       ON CONFLICT (phone)
       DO UPDATE SET customer_id = excluded.customer_id,
                     target = excluded.target,
                     params = excluded.params,
                     credits = excluded.credits,
                     created_at = now()
       RETURNING *`,
      [input.phone, input.customerId, input.target, JSON.stringify(input.params), input.credits]
    );
    return result.rows[0];
  }

  /** The outstanding comps offer for a phone, or null when there is none. */
  async getPending(phone: string): Promise<CompsPendingRow | null> {
    const result = await this.db.query<CompsPendingRow>(
      `SELECT * FROM text_jake_comps_pending WHERE phone = $1`,
      [phone]
    );
    return result.rows[0] ?? null;
  }

  /** Clear a phone's outstanding comps offer (on confirm, or when it moves on). */
  async clearPending(phone: string): Promise<void> {
    await this.db.query(`DELETE FROM text_jake_comps_pending WHERE phone = $1`, [phone]);
  }
}
