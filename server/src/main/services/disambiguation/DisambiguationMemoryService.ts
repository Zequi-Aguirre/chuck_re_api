import { injectable } from "tsyringe";
import { JakeIntent } from "../orchestrator/OrchestratorTypes";
import { CompParamOverrides } from "../comps/CompsTypes";
import { DisambiguationStore } from "./DisambiguationStore";
import { DisambiguationPendingRow } from "./DisambiguationTypes";

/**
 * The read/write BUSINESS surface for the pending DISAMBIGUATION question
 * (JAK-138). It sits between {@link
 * import("../JakeAssistantService").JakeAssistantService} and the pure-SQL {@link
 * DisambiguationStore}, mirroring the JAK-136 {@link
 * import("../skiptrace/SkipTraceMemoryService").SkipTraceMemoryService}: it owns
 * the pending-offer TTL so it stays unit-testable without the wall clock.
 *
 * A question that ages past {@link PENDING_TTL_MS} is treated as unrelated — a
 * bare number long after the ask is NOT read as a stale pick — and is cleared so
 * it can never fire later.
 */
@injectable()
export class DisambiguationMemoryService {
  /** How long a "which address did you mean?" question stays selectable. */
  static readonly PENDING_TTL_MS = 60 * 60 * 1000; // 1 hour

  constructor(private readonly store: DisambiguationStore) {}

  /** Record the outstanding disambiguation question for a phone. */
  async setPending(input: {
    phone: string;
    customerId: string;
    intent: JakeIntent;
    compParams: CompParamOverrides | null;
  }): Promise<DisambiguationPendingRow> {
    return this.store.setPending(input);
  }

  /**
   * The FRESH outstanding disambiguation question for a phone, or null when there's
   * none or it has aged past {@link PENDING_TTL_MS}. A stale question is cleared so
   * a later bare number can never resolve against it.
   */
  async freshPending(phone: string): Promise<DisambiguationPendingRow | null> {
    const pending = await this.store.getPending(phone);
    if (!pending) return null;
    const age = this.clock() - pending.created_at.getTime();
    if (age >= DisambiguationMemoryService.PENDING_TTL_MS) {
      await this.store.clearPending(phone);
      return null;
    }
    return pending;
  }

  /** Clear a phone's outstanding question (on pick, or when the conversation moves on). */
  async clearPending(phone: string): Promise<void> {
    return this.store.clearPending(phone);
  }

  /** Time source — indirection so the TTL boundary is testable without the clock. */
  protected clock(): number {
    return Date.now();
  }
}
