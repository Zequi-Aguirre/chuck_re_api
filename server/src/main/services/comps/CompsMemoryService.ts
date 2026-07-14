import { injectable } from "tsyringe";
import { ConversationSettingsService } from "../../ghlEnrichment/conversation/ConversationSettingsService";
import { CompsStore } from "./CompsStore";
import { CompParams, CompsPendingRow, CompsRow, compsCacheKey } from "./CompsTypes";

const DAY_MS = 86_400_000;

/**
 * The read/write BUSINESS surface for the comps cache + the pending
 * confirm-before-spend offer (JAK-137). It sits between {@link
 * import("../JakeAssistantService").JakeAssistantService} and the pure-SQL {@link
 * CompsStore}, mirroring the JAK-136 {@link
 * import("../skiptrace/SkipTraceMemoryService").SkipTraceMemoryService}.
 *
 * It deliberately REUSES the JAK-134 `free_reserve_window_days` knob (via {@link
 * ConversationSettingsService}) rather than forking a third window: a repeat comps
 * request for the same target AND the same parameter-set within that window is
 * re-served FREE from the snapshot. A DIFFERENT parameter-set is a new request (the
 * cache key folds in the params), not a hit. It owns the free-window boundary + the
 * pending-offer TTL so both stay unit-testable without the wall clock.
 */
@injectable()
export class CompsMemoryService {
  /**
   * How long a "reply OK to run it" comps offer stays valid. A bare OK after this
   * long is treated as unrelated, not a (potentially costly) confirmation.
   */
  static readonly PENDING_TTL_MS = 60 * 60 * 1000; // 1 hour

  constructor(
    private readonly store: CompsStore,
    private readonly settings: ConversationSettingsService
  ) {}

  /** Snapshot a PAID comps result so a repeat within the free window is free. */
  async recordComps(input: {
    customerId: string;
    phone: string;
    messageId: string | null;
    normalizedTarget: string;
    params: CompParams;
    compsRecord: unknown;
    reportText: string;
  }): Promise<CompsRow> {
    return this.store.recordComps({
      ...input,
      targetKey: compsCacheKey(input.normalizedTarget, input.params),
    });
  }

  /**
   * Cache-check: the stored snapshot for (phone, target, params) IF the last paid
   * comps pull for it is still within the free re-serve window, else null. Measured
   * against `fetched_at`; the boundary is exclusive — a snapshot exactly
   * `free_reserve_window_days` old (or older) is stale and triggers a fresh pull.
   * The parameter-set is part of the key, so a different search never hits this.
   */
  async checkCache(phone: string, target: string, params: CompParams): Promise<CompsRow | null> {
    const latest = await this.store.latestComps(phone, compsCacheKey(target, params));
    if (!latest) return null;
    const windowDays = await this.settings.freeReserveWindowDays();
    const cutoff = this.clock() - windowDays * DAY_MS;
    return latest.fetched_at.getTime() > cutoff ? latest : null;
  }

  /** Record the outstanding "reply OK" comps offer for a phone. */
  async setPending(input: {
    phone: string;
    customerId: string;
    target: string;
    params: CompParams;
    credits: number;
  }): Promise<CompsPendingRow> {
    return this.store.setPending(input);
  }

  /**
   * The FRESH outstanding comps offer for a phone, or null when there's none or the
   * offer has aged past {@link PENDING_TTL_MS}. A stale offer is cleared so it can
   * never fire later.
   */
  async freshPending(phone: string): Promise<CompsPendingRow | null> {
    const pending = await this.store.getPending(phone);
    if (!pending) return null;
    const age = this.clock() - pending.created_at.getTime();
    if (age >= CompsMemoryService.PENDING_TTL_MS) {
      await this.store.clearPending(phone);
      return null;
    }
    return pending;
  }

  /** Clear a phone's outstanding offer (on confirm, or when the conversation moves on). */
  async clearPending(phone: string): Promise<void> {
    return this.store.clearPending(phone);
  }

  /** Time source — indirection so the free-window + TTL boundaries are testable. */
  protected clock(): number {
    return Date.now();
  }
}
