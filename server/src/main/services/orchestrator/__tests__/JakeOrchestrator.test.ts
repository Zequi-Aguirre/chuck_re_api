import { mock, MockProxy } from "jest-mock-extended";
import { JakeOrchestrator } from "../JakeOrchestrator";
import { OrchestratorPromptService } from "../OrchestratorPromptService";
import { SpecialistRegistry } from "../SpecialistRegistry";
import { RouterClassification, RouterLlmClient } from "../RouterLlmClient";
import { ConversationMemoryService } from "../../../ghlEnrichment/conversation/ConversationMemoryService";
import { ConversationMessageRow } from "../../../ghlEnrichment/conversation/ConversationTypes";

/**
 * The JAK-135 router. These tests pin the two things the orchestrator OWNS:
 *   - it reads JAK-134 memory (recent window + the ordered resolved-address list)
 *     and feeds it to the LLM, which is INJECTED and MOCKED (never a network call);
 *   - it turns a classification into a typed plan, deterministically resolving
 *     references ("the 2nd address I sent") into a concrete target address.
 */
describe("JakeOrchestrator (JAK-135 router)", () => {
  let prompts: MockProxy<OrchestratorPromptService>;
  let memory: MockProxy<ConversationMemoryService>;
  let llm: MockProxy<RouterLlmClient>;
  let registry: SpecialistRegistry;
  let orchestrator: JakeOrchestrator;

  const classification = (over: Partial<RouterClassification> = {}): RouterClassification => ({
    intent: "chitchat",
    targetAddress: null,
    addressOrdinal: null,
    userFacingNote: "",
    ...over,
  });

  const msg = (body: string, direction: "inbound" | "outbound"): ConversationMessageRow => ({
    id: `m_${body}`,
    customer_id: "cust_1",
    phone: "+15559990000",
    direction,
    body,
    resolved_address: null,
    tenant_location_id: null,
    text_mode: "gateway",
    created_at: new Date("2026-07-01T00:00:00Z"),
  });

  beforeEach(() => {
    prompts = mock<OrchestratorPromptService>();
    memory = mock<ConversationMemoryService>();
    llm = mock<RouterLlmClient>();
    registry = new SpecialistRegistry(); // the real registry — its descriptors matter

    prompts.getEffectivePrompt.mockResolvedValue("STYLE PROMPT");
    memory.recentMessages.mockResolvedValue([]);
    memory.resolvedAddressList.mockResolvedValue([]);
    llm.classify.mockResolvedValue(classification());

    orchestrator = new JakeOrchestrator(prompts, memory, registry, llm);
  });

  it("feeds the LLM the recent window + ordered resolved-address list + admin prompt", async () => {
    memory.recentMessages.mockResolvedValue([msg("123 Main St", "inbound"), msg("here you go", "outbound")]);
    memory.resolvedAddressList.mockResolvedValue(["123 Main St, Springfield, IL 62704"]);

    await orchestrator.plan({
      phone: "+15559990000",
      message: "who owns it?",
      parsedAddress: null,
      isAffirmative: false,
    });

    expect(memory.recentMessages).toHaveBeenCalledWith("+15559990000");
    expect(memory.resolvedAddressList).toHaveBeenCalledWith("+15559990000");
    expect(llm.classify).toHaveBeenCalledWith(
      expect.objectContaining({
        systemPrompt: "STYLE PROMPT",
        message: "who owns it?",
        resolvedAddresses: ["123 Main St, Springfield, IL 62704"],
        recentMessages: [
          { direction: "inbound", body: "123 Main St" },
          { direction: "outbound", body: "here you go" },
        ],
      })
    );
  });

  describe("intent classification → typed plan", () => {
    it("property_report on an explicit address the model returned", async () => {
      llm.classify.mockResolvedValue(
        classification({ intent: "property_report", targetAddress: "9 New St, Town, CA 90000" })
      );

      const plan = await orchestrator.plan({
        phone: "+15559990000",
        message: "9 New St, Town, CA 90000",
        parsedAddress: "9 New St, Town, CA 90000",
        isAffirmative: false,
      });

      expect(plan.intent).toBe("property_report");
      expect(plan.targetEntity).toBe("9 New St, Town, CA 90000");
      expect(plan.specialists).toEqual([{ name: "report", needsConfirmation: false, estimatedCredits: 1 }]);
    });

    it("report_refresh carries the Report specialist and a null target (last address resolved downstream)", async () => {
      llm.classify.mockResolvedValue(classification({ intent: "report_refresh" }));

      const plan = await orchestrator.plan({
        phone: "+15559990000",
        message: "OK",
        parsedAddress: null,
        isAffirmative: true,
      });

      expect(plan.intent).toBe("report_refresh");
      expect(plan.targetEntity).toBeNull();
      expect(plan.specialists[0].name).toBe("report");
    });

    it("skip_trace → BUILT (JAK-136) confirm-before-spend metadata + resolves a target address", async () => {
      llm.classify.mockResolvedValue(
        classification({ intent: "skip_trace", targetAddress: "9 New St, Town, CA 90000" })
      );

      const plan = await orchestrator.plan({
        phone: "+15559990000",
        message: "who owns 9 New St?",
        parsedAddress: "9 New St, Town, CA 90000",
        isAffirmative: false,
      });

      expect(plan.intent).toBe("skip_trace");
      expect(plan.specialists).toEqual([{ name: "skip_trace", needsConfirmation: true, estimatedCredits: 3 }]);
      // JAK-136 flipped this on: skip trace is now a real, runnable specialist.
      expect(registry.isAvailable("skip_trace")).toBe(true);
      // Unlike the coming-soon stub, skip trace now carries a resolved target.
      expect(plan.targetEntity).toBe("9 New St, Town, CA 90000");
    });

    it("skip_trace resolves an ordinal reference like property_report does", async () => {
      memory.resolvedAddressList.mockResolvedValue([
        "1 First St, Town, CA 90000",
        "2 Second Ave, Town, CA 90000",
      ]);
      llm.classify.mockResolvedValue(classification({ intent: "skip_trace", addressOrdinal: 2 }));

      const plan = await orchestrator.plan({
        phone: "+15559990000",
        message: "skip trace the 2nd one",
        parsedAddress: null,
        isAffirmative: false,
      });

      expect(plan.targetEntity).toBe("2 Second Ave, Town, CA 90000");
    });

    it("comps → BUILT (JAK-137) confirm-before-spend metadata + resolves a target address", async () => {
      llm.classify.mockResolvedValue(
        classification({ intent: "comps", targetAddress: "9 New St, Town, CA 90000" })
      );

      const plan = await orchestrator.plan({
        phone: "+15559990000",
        message: "comps for 9 New St",
        parsedAddress: "9 New St, Town, CA 90000",
        isAffirmative: false,
      });

      expect(plan.intent).toBe("comps");
      expect(plan.specialists).toEqual([{ name: "comps", needsConfirmation: true, estimatedCredits: 3 }]);
      // JAK-137 flipped this on: comps is now a real, runnable specialist.
      expect(registry.isAvailable("comps")).toBe(true);
      // Unlike the old coming-soon stub, comps now carries a resolved target.
      expect(plan.targetEntity).toBe("9 New St, Town, CA 90000");
    });

    it("comps carries the texter's parameter overrides through to the plan (JAK-137)", async () => {
      llm.classify.mockResolvedValue(
        classification({
          intent: "comps",
          targetAddress: "9 New St, Town, CA 90000",
          compParams: { radiusMiles: 1, monthsBack: 6, count: 3 },
        })
      );

      const plan = await orchestrator.plan({
        phone: "+15559990000",
        message: "comps within 1 mile, last 6 months, 3 similar homes for 9 New St",
        parsedAddress: "9 New St, Town, CA 90000",
        isAffirmative: false,
      });

      expect(plan.compParams).toEqual({ radiusMiles: 1, monthsBack: 6, count: 3 });
    });

    it("does not carry comp params for non-comps intents", async () => {
      llm.classify.mockResolvedValue(
        classification({ intent: "property_report", targetAddress: "9 New St, Town, CA 90000", compParams: { count: 3 } })
      );

      const plan = await orchestrator.plan({
        phone: "+15559990000",
        message: "9 New St, Town, CA 90000",
        parsedAddress: "9 New St, Town, CA 90000",
        isAffirmative: false,
      });

      expect(plan.compParams).toBeNull();
    });

    it("chitchat → no specialists, no target", async () => {
      llm.classify.mockResolvedValue(classification({ intent: "chitchat" }));

      const plan = await orchestrator.plan({
        phone: "+15559990000",
        message: "hey there",
        parsedAddress: null,
        isAffirmative: false,
      });

      expect(plan.intent).toBe("chitchat");
      expect(plan.specialists).toEqual([]);
      expect(plan.targetEntity).toBeNull();
    });
  });

  describe("reference resolution against the ordered resolved-address list", () => {
    const ADDRESSES = [
      "1 First St, Town, CA 90000",
      "2 Second Ave, Town, CA 90000",
      "3 Third Blvd, Town, CA 90000",
    ];

    beforeEach(() => memory.resolvedAddressList.mockResolvedValue(ADDRESSES));

    it("resolves 'the 2nd address I sent' to the 2nd entry (1-based ordinal)", async () => {
      llm.classify.mockResolvedValue(classification({ intent: "property_report", addressOrdinal: 2 }));

      const plan = await orchestrator.plan({
        phone: "+15559990000",
        message: "who owns the 2nd address I sent?",
        parsedAddress: null,
        isAffirmative: false,
      });

      expect(plan.targetEntity).toBe("2 Second Ave, Town, CA 90000");
    });

    it("resolves 'the last one' to the final entry", async () => {
      llm.classify.mockResolvedValue(classification({ intent: "property_report", addressOrdinal: 3 }));

      const plan = await orchestrator.plan({
        phone: "+15559990000",
        message: "pull the last one",
        parsedAddress: null,
        isAffirmative: false,
      });

      expect(plan.targetEntity).toBe("3 Third Blvd, Town, CA 90000");
    });

    it("an out-of-range ordinal yields a null target (assistant will clarify)", async () => {
      llm.classify.mockResolvedValue(classification({ intent: "property_report", addressOrdinal: 9 }));

      const plan = await orchestrator.plan({
        phone: "+15559990000",
        message: "the 9th one",
        parsedAddress: null,
        isAffirmative: false,
      });

      expect(plan.targetEntity).toBeNull();
    });

    it("prefers an explicit new address over an ordinal, and falls back to the parsed address", async () => {
      llm.classify.mockResolvedValue(
        classification({ intent: "property_report", targetAddress: "42 Galaxy Way, Town, CA 90000", addressOrdinal: 1 })
      );
      const explicit = await orchestrator.plan({
        phone: "+15559990000",
        message: "42 Galaxy Way, Town, CA 90000",
        parsedAddress: "42 Galaxy Way, Town, CA 90000",
        isAffirmative: false,
      });
      expect(explicit.targetEntity).toBe("42 Galaxy Way, Town, CA 90000");

      // No explicit address + no ordinal → fall back to the deterministically parsed one.
      llm.classify.mockResolvedValue(classification({ intent: "property_report" }));
      const parsed = await orchestrator.plan({
        phone: "+15559990000",
        message: "7 Parsed Rd, Town, CA 90000",
        parsedAddress: "7 Parsed Rd, Town, CA 90000",
        isAffirmative: false,
      });
      expect(parsed.targetEntity).toBe("7 Parsed Rd, Town, CA 90000");
    });
  });
});
