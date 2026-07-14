import { injectable } from "tsyringe";
import { PostgresDatabase } from "../../data/PostgresDatabase";
import { JakeIntent } from "../orchestrator/OrchestratorTypes";
import { CompParamOverrides } from "../comps/CompsTypes";
import { DisambiguationPendingRow } from "./DisambiguationTypes";

/**
 * Data-access layer for the pending DISAMBIGUATION question (JAK-138). Pure SQL
 * over {@link PostgresDatabase}, mirroring the JAK-136 {@link
 * import("../skiptrace/SkipTraceStore").SkipTraceStore}: snake_case columns, one
 * upserted row per phone, NO business rules. The freshness TTL lives in the
 * service ({@link
 * import("./DisambiguationMemoryService").DisambiguationMemoryService}) so it
 * stays unit-testable without the wall clock. It holds NO credential.
 */
@injectable()
export class DisambiguationStore {
  constructor(private readonly db: PostgresDatabase) {}

  /**
   * Record (upsert) the ONE outstanding disambiguation question for a phone. A new
   * question replaces any prior one, so a following pick always resolves the most
   * recent ask. `compParams` is persisted only for a pending comps question.
   */
  async setPending(input: {
    phone: string;
    customerId: string;
    intent: JakeIntent;
    compParams: CompParamOverrides | null;
  }): Promise<DisambiguationPendingRow> {
    const result = await this.db.query<DisambiguationPendingRow>(
      `INSERT INTO text_jake_pending_disambiguation (phone, customer_id, intent, comp_params, created_at)
       VALUES ($1, $2, $3, $4::jsonb, now())
       ON CONFLICT (phone)
       DO UPDATE SET customer_id = excluded.customer_id,
                     intent = excluded.intent,
                     comp_params = excluded.comp_params,
                     created_at = now()
       RETURNING *`,
      [
        input.phone,
        input.customerId,
        input.intent,
        input.compParams ? JSON.stringify(input.compParams) : null,
      ]
    );
    return result.rows[0];
  }

  /** The outstanding disambiguation question for a phone, or null when there is none. */
  async getPending(phone: string): Promise<DisambiguationPendingRow | null> {
    const result = await this.db.query<DisambiguationPendingRow>(
      `SELECT * FROM text_jake_pending_disambiguation WHERE phone = $1`,
      [phone]
    );
    return result.rows[0] ?? null;
  }

  /** Clear a phone's outstanding disambiguation question (on pick, or when it moves on). */
  async clearPending(phone: string): Promise<void> {
    await this.db.query(`DELETE FROM text_jake_pending_disambiguation WHERE phone = $1`, [phone]);
  }
}
