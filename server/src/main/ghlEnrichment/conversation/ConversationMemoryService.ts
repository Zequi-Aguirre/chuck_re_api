import { injectable } from "tsyringe";
import { ConversationSettingsService } from "./ConversationSettingsService";
import { ConversationStore } from "./ConversationStore";
import {
  ConversationMessageRow,
  LookupRow,
  addressCacheKey,
} from "./ConversationTypes";

const DAY_MS = 86_400_000;

/**
 * The read/write BUSINESS surface for per-phone conversation memory + the
 * property lookup cache (JAK-134) — the FOUNDATION of the Conversational
 * Text-Jake epic. It sits between {@link JakeAssistantService} and the pure-SQL
 * {@link ConversationStore}, mirroring how {@link CreditService} fronts the
 * ledger store: the store persists rows, this service applies the two
 * admin-configurable knobs ({@link ConversationSettingsService} — context window
 * size + free re-serve window) and owns the free-window boundary so it stays
 * unit-testable without the wall clock.
 *
 * Responsibilities:
 *   - append every inbound message, and the outbound replies, in order;
 *   - read the recent message window (sized by context_window_size);
 *   - record a paid lookup result (snapshot + per-phone order index);
 *   - cache-check (phone, address): return a stored snapshot iff one exists
 *     within the free re-serve window, else null.
 */
@injectable()
export class ConversationMemoryService {
  constructor(
    private readonly store: ConversationStore,
    private readonly settings: ConversationSettingsService
  ) {}

  /** Persist an inbound message (with the address we resolved from it, if any). */
  async appendInbound(input: {
    customerId: string;
    phone: string;
    body: string;
    resolvedAddress: string | null;
    tenantLocationId: string | null;
    textMode: string;
  }): Promise<ConversationMessageRow> {
    return this.store.appendMessage({ ...input, direction: "inbound" });
  }

  /** Persist an outbound reply we sent. */
  async appendOutbound(input: {
    customerId: string;
    phone: string;
    body: string;
    tenantLocationId: string | null;
    textMode: string;
  }): Promise<ConversationMessageRow> {
    return this.store.appendMessage({ ...input, direction: "outbound", resolvedAddress: null });
  }

  /**
   * The recent conversation window for a phone, OLDEST-first (chronological),
   * capped at the admin-configured `context_window_size`. This is the value a
   * later orchestrator (JAK-135) reads to build model context.
   */
  async recentMessages(phone: string): Promise<ConversationMessageRow[]> {
    const limit = await this.settings.contextWindowSize();
    const newestFirst = await this.store.recentMessages(phone, limit);
    return newestFirst.reverse();
  }

  /** "The last address they sent" — resolves an OK refresh that carries no address. */
  async lastResolvedAddress(phone: string): Promise<string | null> {
    return this.store.lastResolvedAddress(phone);
  }

  /** Snapshot a paid PropertySearch result so a repeat within the window is free. */
  async recordLookup(input: {
    customerId: string;
    phone: string;
    messageId: string | null;
    normalizedAddress: string;
    propertyId: string | null;
    propertyRecord: unknown;
    reportText: string;
  }): Promise<LookupRow> {
    return this.store.recordLookup({
      ...input,
      addressKey: addressCacheKey(input.normalizedAddress),
    });
  }

  /**
   * Cache-check: the stored snapshot for (phone, address) IF the last paid fetch
   * for it is still within the free re-serve window, else null. The window is
   * measured against `fetched_at`; the boundary is exclusive — a snapshot exactly
   * `free_reserve_window_days` old (or older) is stale and triggers a fresh paid
   * lookup.
   */
  async checkCache(phone: string, address: string): Promise<LookupRow | null> {
    const latest = await this.store.latestLookup(phone, addressCacheKey(address));
    if (!latest) return null;
    const windowDays = await this.settings.freeReserveWindowDays();
    const cutoff = this.clock() - windowDays * DAY_MS;
    return latest.fetched_at.getTime() > cutoff ? latest : null;
  }

  /** Time source — indirection so the free-window boundary is testable. */
  protected clock(): number {
    return Date.now();
  }
}
