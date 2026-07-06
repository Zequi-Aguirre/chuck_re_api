import { injectable } from "tsyringe";
import { PostgresDatabase } from "../../data/PostgresDatabase";
import {
  ConversationMessageRow,
  LookupRow,
  MessageDirection,
} from "./ConversationTypes";

/**
 * Data-access layer for per-phone conversation memory + the property lookup
 * cache (JAK-134). Pure SQL over {@link PostgresDatabase}, mirroring the house
 * stores (JAK-102/109/115): snake_case columns, timestamptz timestamps, lazy
 * pool, no business rules. The read/write BUSINESS surface (context window size,
 * free re-serve window) lives in {@link import("./ConversationMemoryService").ConversationMemoryService}.
 *
 * It holds NO credential and makes NO external call — it only persists what the
 * assistant already handled.
 */
@injectable()
export class ConversationStore {
  constructor(private readonly db: PostgresDatabase) {}

  /** Append one message to a phone's ordered conversation history. */
  async appendMessage(input: {
    customerId: string;
    phone: string;
    direction: MessageDirection;
    body: string;
    resolvedAddress?: string | null;
    tenantLocationId?: string | null;
    textMode?: string | null;
  }): Promise<ConversationMessageRow> {
    const result = await this.db.query<ConversationMessageRow>(
      `INSERT INTO text_jake_conversation_messages
         (customer_id, phone, direction, body, resolved_address, tenant_location_id, text_mode)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        input.customerId,
        input.phone,
        input.direction,
        input.body,
        input.resolvedAddress ?? null,
        input.tenantLocationId ?? null,
        input.textMode ?? null,
      ]
    );
    return result.rows[0];
  }

  /** The most recent `limit` messages for a phone, NEWEST first. */
  async recentMessages(phone: string, limit: number): Promise<ConversationMessageRow[]> {
    const result = await this.db.query<ConversationMessageRow>(
      `SELECT * FROM text_jake_conversation_messages
       WHERE phone = $1
       ORDER BY created_at DESC, id DESC
       LIMIT $2`,
      [phone, limit]
    );
    return result.rows;
  }

  /**
   * Backfill the resolved address onto an already-stored inbound message (JAK-166).
   * The address is captured at INSERT time from a deterministic regex parse of the
   * raw text (see `appendMessage` / `parseCommandAddress`), which fails whenever the
   * texter wraps the address in conversational preamble ("Hey Jake, look up ...") —
   * even though the lookup itself succeeds via the LLM-resolved target. This UPDATE
   * lets the assistant write the address it ACTUALLY acted on back onto the
   * requesting message, so `lastResolvedAddress` / `resolvedAddresses` become a
   * single source of truth for the conversation's active property. No-op if the id
   * is unknown.
   */
  async updateResolvedAddress(messageId: string, resolvedAddress: string): Promise<void> {
    await this.db.query(
      `UPDATE text_jake_conversation_messages
          SET resolved_address = $2
        WHERE id = $1`,
      [messageId, resolvedAddress]
    );
  }

  /**
   * The most recent inbound message for a phone that resolved to an address —
   * i.e. "the last address they sent". Used to resolve an "OK" refresh reply,
   * which carries no address of its own.
   */
  async lastResolvedAddress(phone: string): Promise<string | null> {
    const result = await this.db.query<{ resolved_address: string }>(
      `SELECT resolved_address FROM text_jake_conversation_messages
       WHERE phone = $1 AND direction = 'inbound' AND resolved_address IS NOT NULL
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
      [phone]
    );
    return result.rows[0]?.resolved_address ?? null;
  }

  /**
   * The ordered per-phone list of DISTINCT resolved addresses the sender has
   * texted, oldest-first (by first appearance). This is the "Nth address I sent"
   * index the JAK-135 orchestrator resolves references against ("the 2nd address",
   * "the last one"). Sourced from the inbound message log (every parsed address,
   * not just paid lookups) so it reflects everything the person actually sent;
   * de-duplicated by first send so ordinals are stable.
   */
  async resolvedAddresses(phone: string): Promise<string[]> {
    const result = await this.db.query<{ resolved_address: string }>(
      `SELECT resolved_address
         FROM text_jake_conversation_messages
        WHERE phone = $1 AND direction = 'inbound' AND resolved_address IS NOT NULL
        GROUP BY resolved_address
        ORDER BY MIN(created_at) ASC, resolved_address ASC`,
      [phone]
    );
    return result.rows.map((r) => r.resolved_address);
  }

  /**
   * The latest cached lookup for (phone, address_key), newest first, REGARDLESS
   * of age — the free-window check is applied by the service so its boundary is
   * testable without the clock. Null if this phone never looked up this address.
   */
  async latestLookup(phone: string, addressKey: string): Promise<LookupRow | null> {
    const result = await this.db.query<LookupRow>(
      `SELECT * FROM text_jake_lookups
       WHERE phone = $1 AND address_key = $2
       ORDER BY fetched_at DESC, id DESC
       LIMIT 1`,
      [phone, addressKey]
    );
    return result.rows[0] ?? null;
  }

  /**
   * Snapshot a paid PropertySearch result. The per-phone `order_index` is
   * assigned atomically in the same INSERT (max+1 for the phone), so each stored
   * lookup is the next resolved address for that phone.
   */
  async recordLookup(input: {
    customerId: string;
    phone: string;
    messageId: string | null;
    normalizedAddress: string;
    addressKey: string;
    propertyId: string | null;
    propertyRecord: unknown;
    reportText: string;
  }): Promise<LookupRow> {
    const result = await this.db.query<LookupRow>(
      `INSERT INTO text_jake_lookups
         (customer_id, phone, message_id, normalized_address, address_key,
          order_index, property_id, property_record, report_text)
       SELECT $1, $2, $3, $4, $5,
              COALESCE((SELECT MAX(order_index) FROM text_jake_lookups WHERE phone = $2), 0) + 1,
              $6, $7::jsonb, $8
       RETURNING *`,
      [
        input.customerId,
        input.phone,
        input.messageId,
        input.normalizedAddress,
        input.addressKey,
        input.propertyId,
        JSON.stringify(input.propertyRecord ?? null),
        input.reportText,
      ]
    );
    return result.rows[0];
  }
}
