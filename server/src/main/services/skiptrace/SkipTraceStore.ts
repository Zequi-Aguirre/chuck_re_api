import { injectable } from "tsyringe";
import { PostgresDatabase } from "../../data/PostgresDatabase";
import { SkipTracePendingRow, SkipTraceRow } from "./SkipTraceTypes";

/**
 * Data-access layer for the skip-trace cache + the pending confirm-before-spend
 * offer (JAK-136). Pure SQL over {@link PostgresDatabase}, mirroring the JAK-134
 * {@link import("../../ghlEnrichment/conversation/ConversationStore").ConversationStore}:
 * snake_case columns, timestamptz timestamps, lazy pool, NO business rules and NO
 * external call. The free-window boundary + the pending TTL live in the service
 * ({@link import("./SkipTraceMemoryService").SkipTraceMemoryService}) so they stay
 * unit-testable without the wall clock.
 *
 * It holds NO credential.
 */
@injectable()
export class SkipTraceStore {
  constructor(private readonly db: PostgresDatabase) {}

  /**
   * Snapshot a PAID skip-trace result so a repeat of the same target within the
   * free window re-serves from here instead of calling (and charging for) the API
   * again — the SAME free re-serve rule as the JAK-134 property lookup cache.
   */
  async recordTrace(input: {
    customerId: string;
    phone: string;
    messageId: string | null;
    normalizedTarget: string;
    targetKey: string;
    traceRecord: unknown;
    reportText: string;
  }): Promise<SkipTraceRow> {
    const result = await this.db.query<SkipTraceRow>(
      `INSERT INTO text_jake_skip_traces
         (customer_id, phone, message_id, normalized_target, target_key, trace_record, report_text)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
       RETURNING *`,
      [
        input.customerId,
        input.phone,
        input.messageId,
        input.normalizedTarget,
        input.targetKey,
        JSON.stringify(input.traceRecord ?? null),
        input.reportText,
      ]
    );
    return result.rows[0];
  }

  /**
   * The latest cached trace for (phone, target_key), newest first, REGARDLESS of
   * age — the free-window check is applied by the service so its boundary is
   * testable without the clock. Null if this phone never traced this target.
   */
  async latestTrace(phone: string, targetKey: string): Promise<SkipTraceRow | null> {
    const result = await this.db.query<SkipTraceRow>(
      `SELECT * FROM text_jake_skip_traces
       WHERE phone = $1 AND target_key = $2
       ORDER BY fetched_at DESC, id DESC
       LIMIT 1`,
      [phone, targetKey]
    );
    return result.rows[0] ?? null;
  }

  /**
   * Record (upsert) the ONE outstanding skip-trace offer for a phone. A new offer
   * replaces any prior one, so "reply OK" always resolves to the most recent quote.
   */
  async setPending(input: {
    phone: string;
    customerId: string;
    target: string;
    credits: number;
  }): Promise<SkipTracePendingRow> {
    const result = await this.db.query<SkipTracePendingRow>(
      `INSERT INTO text_jake_skip_trace_pending (phone, customer_id, target, credits, created_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (phone)
       DO UPDATE SET customer_id = excluded.customer_id,
                     target = excluded.target,
                     credits = excluded.credits,
                     created_at = now()
       RETURNING *`,
      [input.phone, input.customerId, input.target, input.credits]
    );
    return result.rows[0];
  }

  /** The outstanding skip-trace offer for a phone, or null when there is none. */
  async getPending(phone: string): Promise<SkipTracePendingRow | null> {
    const result = await this.db.query<SkipTracePendingRow>(
      `SELECT * FROM text_jake_skip_trace_pending WHERE phone = $1`,
      [phone]
    );
    return result.rows[0] ?? null;
  }

  /** Clear a phone's outstanding skip-trace offer (on confirm, or when it moves on). */
  async clearPending(phone: string): Promise<void> {
    await this.db.query(`DELETE FROM text_jake_skip_trace_pending WHERE phone = $1`, [phone]);
  }
}
