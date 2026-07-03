import { inject, injectable } from "tsyringe";
import { ConversationMemoryService } from "../../ghlEnrichment/conversation/ConversationMemoryService.ts";
import { OrchestratorPromptService } from "./OrchestratorPromptService.ts";
import { SpecialistRegistry } from "./SpecialistRegistry.ts";
import {
  ROUTER_LLM_CLIENT,
  RouterClassification,
  RouterLlmClient,
} from "./RouterLlmClient.ts";
import {
  DispatchPlan,
  JakeIntent,
  OrchestratorInput,
  SpecialistPlan,
} from "./OrchestratorTypes.ts";

/**
 * The text-Jake ORCHESTRATOR / ROUTER (JAK-135) — the brain that turns Jake from
 * single-path into conversational multi-capability.
 *
 * For EVERY inbound message it reads the JAK-134 conversation memory (the recent
 * window, sized by `context_window_size`, plus the ordered per-phone
 * resolved-address list), asks the injected {@link RouterLlmClient} to classify
 * intent and resolve references, and emits a typed {@link DispatchPlan}: which
 * specialist(s) to run and on which resolved entity. The assistant executes the
 * plan.
 *
 * Reference resolution is deterministic here (not in the model): the LLM returns
 * either a fresh explicit address or a 1-based ordinal into the resolved-address
 * list ("the 2nd address I sent", "the last one"); this service maps the ordinal
 * to the concrete address, so a mocked LLM makes the mapping fully unit-testable.
 *
 * It only READS memory (writes stay in the assistant, JAK-134). The specialist
 * names come from the {@link SpecialistRegistry} so JAK-136 (skip-trace) and
 * JAK-137 (comps) plug in without rewriting this router.
 */
@injectable()
export class JakeOrchestrator {
  constructor(
    private readonly prompts: OrchestratorPromptService,
    private readonly memory: ConversationMemoryService,
    private readonly registry: SpecialistRegistry,
    @inject(ROUTER_LLM_CLIENT) private readonly llm: RouterLlmClient
  ) {}

  /**
   * Classify one inbound message into a dispatch plan. Reads the recent window +
   * the ordered resolved-address list, runs the router LLM, then resolves any
   * reference into a concrete target address.
   */
  async plan(input: OrchestratorInput): Promise<DispatchPlan> {
    const [recentMessages, resolvedAddresses, systemPrompt] = await Promise.all([
      this.memory.recentMessages(input.phone),
      this.memory.resolvedAddressList(input.phone),
      this.prompts.getEffectivePrompt(),
    ]);

    const classification = await this.llm.classify({
      systemPrompt,
      message: input.message,
      parsedAddress: input.parsedAddress,
      isAffirmative: input.isAffirmative,
      recentMessages: recentMessages.map((m) => ({ direction: m.direction, body: m.body })),
      resolvedAddresses,
    });

    return this.toPlan(classification, resolvedAddresses, input);
  }

  /** Assemble the typed plan: resolve the target entity + attach specialist metadata. */
  private toPlan(
    classification: RouterClassification,
    resolvedAddresses: string[],
    input: OrchestratorInput
  ): DispatchPlan {
    const intent = classification.intent;
    const targetEntity = this.resolveTarget(intent, classification, resolvedAddresses, input);
    return {
      intent,
      targetEntity,
      specialists: this.specialistsFor(intent),
      userFacingNote: classification.userFacingNote ?? "",
      // Carry the texter's comp parameter overrides through for the comps intent
      // only (JAK-137); other intents never read them.
      compParams: intent === "comps" ? classification.compParams ?? null : null,
      // Carry the texter-named people through for the skip_trace intent only
      // (JAK-145); other intents never read them.
      personNames: intent === "skip_trace" ? classification.personNames ?? null : null,
      // Pass the raw referenced ordinal through so the assistant can tell an
      // out-of-range reference ("the 5th address") apart from no reference at all
      // (JAK-138 disambiguation).
      addressOrdinal: classification.addressOrdinal ?? null,
    };
  }

  /**
   * Resolve the concrete entity the plan acts on. property_report, skip_trace
   * (JAK-136), AND comps (JAK-137) all act on an address: prefer a fresh explicit
   * address, else an ordinal reference into the resolved-address list (out-of-range
   * → null so the assistant can clarify), else the deterministically-parsed address.
   * When none resolves here, the assistant falls back to the last resolved address
   * at execution time (e.g. a bare "pull comps"). report_refresh's target is the
   * last address, also resolved by the assistant. chitchat carries no target.
   */
  private resolveTarget(
    intent: JakeIntent,
    classification: RouterClassification,
    resolvedAddresses: string[],
    input: OrchestratorInput
  ): string | null {
    if (intent !== "property_report" && intent !== "skip_trace" && intent !== "comps") return null;

    if (classification.targetAddress) return classification.targetAddress;

    const ordinal = classification.addressOrdinal;
    if (ordinal != null && ordinal >= 1 && ordinal <= resolvedAddresses.length) {
      return resolvedAddresses[ordinal - 1];
    }

    return input.parsedAddress;
  }

  /**
   * The specialist(s) an intent runs, with confirm-before-spend metadata from the
   * registry. Report intents run the Report specialist; skip-trace (JAK-136) and
   * comps (JAK-137) run their built specialist; chitchat runs none.
   */
  private specialistsFor(intent: JakeIntent): SpecialistPlan[] {
    switch (intent) {
      case "property_report":
      case "report_refresh":
        return this.descriptorPlan(SpecialistRegistry.REPORT);
      case "skip_trace":
        return this.descriptorPlan(SpecialistRegistry.SKIP_TRACE);
      case "comps":
        return this.descriptorPlan(SpecialistRegistry.COMPS);
      case "chitchat":
      default:
        return [];
    }
  }

  /** One specialist plan entry from the registry descriptor (or a safe default). */
  private descriptorPlan(name: string): SpecialistPlan[] {
    const descriptor = this.registry.get(name);
    return [
      {
        name,
        needsConfirmation: descriptor?.needsConfirmation ?? false,
        estimatedCredits: descriptor?.estimatedCredits ?? 0,
      },
    ];
  }
}
