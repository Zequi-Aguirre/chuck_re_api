import { injectable } from "tsyringe";
import { ConversationSettingsService } from "../../ghlEnrichment/conversation/ConversationSettingsService";
import { SkipTraceStore } from "./SkipTraceStore";
import { SkipTracePendingRow, SkipTraceRow, skipTraceTargetKey } from "./SkipTraceTypes";

const DAY_MS = 86_400_000;

/**
 * The read/write BUSINESS surface for the skip-trace cache + the pending
 * confirm-before-spend offer (JAK-136). It sits between {@link
 * import("../JakeAssistantService").JakeAssistantService} and the pure-SQL {@link
 * SkipTraceStore}, mirroring how {@link
 * import("../../ghlEnrichment/conversation/ConversationMemoryService").ConversationMemoryService}
 * fronts the JAK-134 lookup cache.
 *
 * It deliberately REUSES the JAK-134 `free_reserve_window_days` knob (via {@link
 * ConversationSettingsService}) rather than forking a second window: a repeat
 * skip-trace of the same target within that window is re-served FREE from the
 * snapshot. It owns the free-window boundary + the pending-offer TTL so both stay
 * unit-testable without the wall clock.
 */
@injectable()
export class SkipTraceMemoryService {
  /**
   * How long a "reply OK to run it" skip-trace offer stays valid. A bare OK after
   * this long is treated as unrelated, not a (potentially costly) confirmation.
   */
  static readonly PENDING_TTL_MS = 60 * 60 * 1000; // 1 hour

  constructor(
    private readonly store: SkipTraceStore,
    private readonly settings: ConversationSettingsService
  ) {}

  /** Snapshot a PAID skip-trace result so a repeat within the free window is free. */
  async recordTrace(input: {
    customerId: string;
    phone: string;
    messageId: string | null;
    normalizedTarget: string;
    traceRecord: unknown;
    reportText: string;
  }): Promise<SkipTraceRow> {
    return this.store.recordTrace({
      ...input,
      targetKey: skipTraceTargetKey(input.normalizedTarget),
    });
  }

  /**
   * Cache-check: the stored snapshot for (phone, target) IF the last paid trace
   * for it is still within the free re-serve window, else null. Measured against
   * `fetched_at`; the boundary is exclusive — a snapshot exactly
   * `free_reserve_window_days` old (or older) is stale and triggers a fresh trace.
   */
  async checkCache(phone: string, target: string): Promise<SkipTraceRow | null> {
    const latest = await this.store.latestTrace(phone, skipTraceTargetKey(target));
    if (!latest) return null;
    const windowDays = await this.settings.freeReserveWindowDays();
    const cutoff = this.clock() - windowDays * DAY_MS;
    return latest.fetched_at.getTime() > cutoff ? latest : null;
  }

  /**
   * The most recent trace for a phone across ALL targets — the entities the JAK-138
   * person reference ("the 3rd person / that owner") resolves against. Null when
   * this phone has never traced anything.
   */
  async latestTraceForPhone(phone: string): Promise<SkipTraceRow | null> {
    return this.store.latestTraceForPhone(phone);
  }

  /** Record the outstanding "reply OK" skip-trace offer for a phone. */
  async setPending(input: {
    phone: string;
    customerId: string;
    target: string;
    credits: number;
  }): Promise<SkipTracePendingRow> {
    return this.store.setPending(input);
  }

  /**
   * The FRESH outstanding skip-trace offer for a phone, or null when there's none
   * or the offer has aged past {@link PENDING_TTL_MS}. A stale offer is cleared so
   * it can never fire later.
   */
  async freshPending(phone: string): Promise<SkipTracePendingRow | null> {
    const pending = await this.store.getPending(phone);
    if (!pending) return null;
    const age = this.clock() - pending.created_at.getTime();
    if (age >= SkipTraceMemoryService.PENDING_TTL_MS) {
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
