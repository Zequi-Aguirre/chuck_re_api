import { mock, MockProxy } from "jest-mock-extended";
import { JakeAssistantService } from "../JakeAssistantService";
import { RealEstateApiDao } from "../../data/RealEstateApiDao";
import { GhlApiClient } from "../../ghlEnrichment/api/GhlApiClient";
import { JakeGatewayClient } from "../../ghlEnrichment/gateway/JakeGatewayClient";
import { GhlConnectionService } from "../../ghlEnrichment/connections/GhlConnectionService";
import { GhlConnection } from "../../ghlEnrichment/connections/GhlConnectionTypes";
import { TextJakeCustomerService } from "../../ghlEnrichment/customers/TextJakeCustomerService";
import { TextJakeCustomer } from "../../ghlEnrichment/customers/TextJakeCustomerTypes";
import { CreditService } from "../../ghlEnrichment/metering/CreditService";
import { CreditSettingsService } from "../../ghlEnrichment/metering/CreditSettingsService";
import { ConversationMemoryService } from "../../ghlEnrichment/conversation/ConversationMemoryService";
import { LookupRow } from "../../ghlEnrichment/conversation/ConversationTypes";
import { PropertyReportWriter } from "../PropertyReportWriter";
import { PropertyReportData } from "../../types/PropertyReport";
import { JakeOrchestrator } from "../orchestrator/JakeOrchestrator";
import { OrchestratorPromptService } from "../orchestrator/OrchestratorPromptService";
import { SpecialistRegistry } from "../orchestrator/SpecialistRegistry";
import { RouterLlmClient } from "../orchestrator/RouterLlmClient";
import { DispatchPlan } from "../orchestrator/OrchestratorTypes";
import { SkipTraceReportWriter } from "../skiptrace/SkipTraceReportWriter";
import { SkipTraceMemoryService } from "../skiptrace/SkipTraceMemoryService";
import { SkipTraceSettingsService } from "../skiptrace/SkipTraceSettingsService";
import { SkipTracePendingRow, SkipTraceRow } from "../skiptrace/SkipTraceTypes";
import { CompsReportWriter } from "../comps/CompsReportWriter";
import { CompsMemoryService } from "../comps/CompsMemoryService";
import { CompsSettingsService } from "../comps/CompsSettingsService";
import { CompsSelectionEngine } from "../comps/CompsSelectionEngine";
import { CompsData, CompsPendingRow, CompsRow, DEFAULT_COMP_PARAMS } from "../comps/CompsTypes";
import { DisambiguationMemoryService } from "../disambiguation/DisambiguationMemoryService";
import { DisambiguationPendingRow } from "../disambiguation/DisambiguationTypes";
import { OnboardingPromptService } from "../onboarding/OnboardingPromptService";
import { FooterService } from "../footer/FooterService";

/**
 * JakeAssistantService is mode-aware (JAK-115). These tests pin the two text
 * modes and their credential/billing seams:
 *   - gateway (default): reply + note go through the MASTER gateway client, never
 *     a per-location key; billing is the texting customer (by sender phone).
 *   - own_number (opt-in): reply + note go through the per-tenant JAK-104 client
 *     on the resolved connection's OWN location + a proven-own reply number (the
 *     JAK-114 path); billing is still the texting customer.
 *   - text_mode selects between them; enrichment's per-tenant path is untouched.
 */
describe("JakeAssistantService (mode-aware text-Jake)", () => {
  let realEstate: MockProxy<RealEstateApiDao>;
  let ghlClient: MockProxy<GhlApiClient>;
  let gateway: MockProxy<JakeGatewayClient>;
  let connections: MockProxy<GhlConnectionService>;
  let customers: MockProxy<TextJakeCustomerService>;
  let credits: MockProxy<CreditService>;
  let creditSettings: MockProxy<CreditSettingsService>;
  let reportWriter: MockProxy<PropertyReportWriter>;
  let memory: MockProxy<ConversationMemoryService>;
  let orchestrator: MockProxy<JakeOrchestrator>;
  let skipTraceWriter: MockProxy<SkipTraceReportWriter>;
  let skipTrace: MockProxy<SkipTraceMemoryService>;
  let skipTraceSettings: MockProxy<SkipTraceSettingsService>;
  let compsWriter: MockProxy<CompsReportWriter>;
  let comps: MockProxy<CompsMemoryService>;
  let compsSettings: MockProxy<CompsSettingsService>;
  let disambiguation: MockProxy<DisambiguationMemoryService>;
  let compsEngine: MockProxy<CompsSelectionEngine>;
  let onboardingPrompt: MockProxy<OnboardingPromptService>;
  let footers: MockProxy<FooterService>;
  let service: JakeAssistantService;

  const reportSpecialist = () => [{ name: "report", needsConfirmation: false, estimatedCredits: 1 }];
  const skipTraceSpecialist = () => [{ name: "skip_trace", needsConfirmation: false, estimatedCredits: 3 }];
  const compsSpecialist = () => [{ name: "comps", needsConfirmation: false, estimatedCredits: 3 }];

  const compsRow = (over: Partial<CompsRow> = {}): CompsRow => ({
    id: "cmp_1",
    customer_id: "cust_x",
    phone: "+15559990000",
    message_id: "msg_1",
    normalized_target: "742 Evergreen Terrace, Springfield, IL 62704",
    target_key: "742 evergreen terrace, springfield, il 62704#r1|c5|m12|bd1|ba1|sf25",
    params: DEFAULT_COMP_PARAMS,
    comps_record: { comps: [{ lastSaleAmount: 400000 }] },
    report_text:
      "Comparable sales for 742 Evergreen Terrace\n123 Nearby St — $400,000\n\nEvery Lead Deserves Jake.\nGoTextJake.com/CRM",
    fetched_at: new Date("2026-07-01T00:00:00Z"),
    created_at: new Date("2026-07-01T00:00:00Z"),
    ...over,
  });

  const compsPendingRow = (over: Partial<CompsPendingRow> = {}): CompsPendingRow => ({
    phone: "+15559990000",
    customer_id: "cust_+15559990000",
    target: "742 Evergreen Terrace, Springfield, IL 62704",
    params: DEFAULT_COMP_PARAMS,
    credits: 3,
    created_at: new Date("2026-07-01T00:00:00Z"),
    ...over,
  });

  const skipTraceRow = (over: Partial<SkipTraceRow> = {}): SkipTraceRow => ({
    id: "st_1",
    customer_id: "cust_x",
    phone: "+15559990000",
    message_id: "msg_1",
    normalized_target: "742 Evergreen Terrace, Springfield, IL 62704",
    target_key: "742 evergreen terrace, springfield, il 62704",
    trace_record: { match: true },
    report_text:
      "Owner of 742 Evergreen Terrace: Homer Simpson\n\nPhone\n• +15550101\n\nEvery Lead Deserves Jake.\nGoTextJake.com/CRM",
    fetched_at: new Date("2026-07-01T00:00:00Z"),
    created_at: new Date("2026-07-01T00:00:00Z"),
    ...over,
  });

  const pendingRow = (over: Partial<SkipTracePendingRow> = {}): SkipTracePendingRow => ({
    phone: "+15559990000",
    customer_id: "cust_+15559990000",
    target: "742 Evergreen Terrace, Springfield, IL 62704",
    credits: 3,
    created_at: new Date("2026-07-01T00:00:00Z"),
    ...over,
  });

  const disambigRow = (over: Partial<DisambiguationPendingRow> = {}): DisambiguationPendingRow => ({
    phone: "+15559990000",
    customer_id: "cust_+15559990000",
    intent: "comps",
    comp_params: null,
    created_at: new Date("2026-07-01T00:00:00Z"),
    ...over,
  });

  const lookupRow = (over: Partial<LookupRow> = {}): LookupRow => ({
    id: "lk_1",
    customer_id: "cust_x",
    phone: "+15559990000",
    message_id: "msg_1",
    normalized_address: "123 Main St, Springfield, IL 62704",
    address_key: "123 main st, springfield, il 62704",
    order_index: 1,
    property_id: "p1",
    property_record: { address: "123 Main St, Springfield, IL 62704" },
    report_text: "Jake Property Report\n123 Main St\n\nEvery Lead Deserves Jake.\nGoTextJake.com/CRM",
    fetched_at: new Date("2026-07-01T00:00:00Z"),
    created_at: new Date("2026-07-01T00:00:00Z"),
    ...over,
  });

  const connection = (over: Partial<GhlConnection> = {}): GhlConnection => ({
    id: "11111111-1111-1111-1111-111111111111",
    locationId: "loc_a",
    apiKey: "unused-in-this-layer",
    baseUrl: "https://a.example.com",
    phoneNumbers: ["+15551110000"],
    status: "active",
    textMode: "own_number",
    autoEnrichmentEnabled: false,
    createdAt: new Date("2026-07-01T00:00:00Z"),
    updatedAt: new Date("2026-07-01T00:00:00Z"),
    ...over,
  });

  // A distinct credit account per phone, so billing-isolation assertions are real.
  const customerFor = (phone: string): TextJakeCustomer => ({
    id: `cust_${phone}`,
    phone,
    ghlContactId: null,
    firstName: null,
    lastName: null,
    email: null,
    status: "active",
    reportCount: 0,
    onboardingAskedAt: null,
    nextResetAt: new Date("2026-08-07T00:00:00Z"),
    creditAccountId: `acct_${phone}`,
    createdAt: new Date("2026-07-01T00:00:00Z"),
    modifiedAt: new Date("2026-07-01T00:00:00Z"),
  });

  beforeEach(() => {
    realEstate = mock<RealEstateApiDao>();
    ghlClient = mock<GhlApiClient>();
    gateway = mock<JakeGatewayClient>();
    connections = mock<GhlConnectionService>();
    customers = mock<TextJakeCustomerService>();
    credits = mock<CreditService>();
    creditSettings = mock<CreditSettingsService>();
    reportWriter = mock<PropertyReportWriter>();
    memory = mock<ConversationMemoryService>();
    orchestrator = mock<JakeOrchestrator>();
    skipTraceWriter = mock<SkipTraceReportWriter>();
    skipTrace = mock<SkipTraceMemoryService>();
    skipTraceSettings = mock<SkipTraceSettingsService>();
    compsWriter = mock<CompsReportWriter>();
    comps = mock<CompsMemoryService>();
    compsEngine = mock<CompsSelectionEngine>();
    compsSettings = mock<CompsSettingsService>();
    disambiguation = mock<DisambiguationMemoryService>();
    onboardingPrompt = mock<OnboardingPromptService>();
    footers = mock<FooterService>();

    // The router is exercised in its own suite (JakeOrchestrator.test.ts); here it
    // defaults to the deterministic classification the pre-router single path used
    // — a parseable address → property_report on it, a bare "OK" → report_refresh,
    // everything else → chitchat — so the JAK-115/130/134 behaviors below are
    // pinned exactly as shipped. Individual tests override plan() when they need a
    // specific intent (e.g. reference resolution, skip-trace, comps).
    orchestrator.plan.mockImplementation(async ({ parsedAddress, isAffirmative }): Promise<DispatchPlan> => {
      if (parsedAddress) {
        return {
          intent: "property_report",
          targetEntity: parsedAddress,
          specialists: reportSpecialist(),
          userFacingNote: "",
        };
      }
      if (isAffirmative) {
        return { intent: "report_refresh", targetEntity: null, specialists: reportSpecialist(), userFacingNote: "" };
      }
      return { intent: "chitchat", targetEntity: null, specialists: [], userFacingNote: "" };
    });

    // Memory is exercised in its own suites; here it defaults to a "no cache,
    // no prior address" world so the classic single-path tests keep their shape.
    memory.appendInbound.mockResolvedValue({ id: "msg_1" } as never);
    memory.appendOutbound.mockResolvedValue({ id: "msg_out" } as never);
    memory.recordLookup.mockResolvedValue({ id: "lk_1" } as never);
    memory.checkCache.mockResolvedValue(null);
    memory.lastResolvedAddress.mockResolvedValue(null);
    memory.resolvedAddressList.mockResolvedValue([]);

    // Disambiguation (JAK-138) defaults: no pending question. Individual tests
    // override to exercise the numbered-selection follow-up.
    disambiguation.freshPending.mockResolvedValue(null);
    disambiguation.setPending.mockResolvedValue(disambigRow());
    disambiguation.clearPending.mockResolvedValue(undefined);
    // Skip-trace person reference (JAK-138): no prior trace on record by default.
    skipTrace.latestTraceForPhone.mockResolvedValue(null);

    // The writer is exercised in its own suite; here it just echoes enough of the
    // assembled data back so the flow assertions (message contains the address)
    // hold, and so we can inspect the VERIFIED data the service handed it.
    reportWriter.write.mockImplementation(
      async (data: PropertyReportData) => `Jake Property Report\n${data.addressLine1 ?? "property"}`
    );

    // Skip-trace (JAK-136) defaults: no cache, no pending offer, cost 3 credits,
    // credits available, writer echoes a clean reply. Individual tests override.
    skipTrace.checkCache.mockResolvedValue(null);
    skipTrace.freshPending.mockResolvedValue(null);
    skipTrace.setPending.mockResolvedValue(pendingRow());
    skipTrace.clearPending.mockResolvedValue(undefined);
    skipTrace.recordTrace.mockResolvedValue(skipTraceRow());
    skipTraceSettings.costOfSkipTrace.mockResolvedValue(3);
    skipTraceWriter.write.mockResolvedValue(
      "Owner of 742 Evergreen Terrace: Homer Simpson\n\nPhone\n• +15550101\n\nEvery Lead Deserves Jake.\nGoTextJake.com/CRM"
    );
    credits.hasCreditsForSkipTrace.mockResolvedValue(true);
    credits.chargeForSkipTrace.mockResolvedValue({ ok: true, balanceAfter: 7, entries: [] });
    credits.getBalance.mockResolvedValue(10);

    // Comps (JAK-137) defaults: no cache, no pending offer, default params, cost 3,
    // credits available, writer echoes a clean reply. Individual tests override.
    comps.checkCache.mockResolvedValue(null);
    comps.freshPending.mockResolvedValue(null);
    comps.setPending.mockResolvedValue(compsPendingRow());
    comps.clearPending.mockResolvedValue(undefined);
    comps.recordComps.mockResolvedValue(compsRow());
    compsSettings.defaultParams.mockResolvedValue(DEFAULT_COMP_PARAMS);
    compsSettings.costOfComps.mockResolvedValue(3);
    compsWriter.write.mockResolvedValue(
      "Comparable sales for 742 Evergreen Terrace\n123 Nearby St — $400,000\n\nEvery Lead Deserves Jake.\nGoTextJake.com/CRM"
    );
    credits.hasCreditsForComps.mockResolvedValue(true);
    credits.chargeForComps.mockResolvedValue({ ok: true, balanceAfter: 7, entries: [] });
    // JAK-164: the selection engine assembles the radius pool + picks the comps and
    // returns the formatter-ready data. Default to a one-comp hit; tests override.
    compsEngine.buildComps.mockResolvedValue({
      data: {
        params: DEFAULT_COMP_PARAMS,
        paramsSummary:
          "radius 1 mi, up to 5 comps, sold in the last 12 months, beds ±1, baths ±1, sqft ±25%",
        subjectAddress: "742 Evergreen Terrace, Springfield, IL 62704",
        comps: [{ address: "123 Nearby St", salePrice: 400000, beds: 3, baths: 2, squareFeet: 1500 }],
        averageSalePrice: 400000,
      } as CompsData,
      record: { source: "radius" },
      source: "radius",
      selectionMode: "deterministic",
      poolSize: 1,
      usableSize: 1,
    });

    customers.resolveByPhone.mockImplementation(async (phone) => customerFor(phone));
    // The assistant resolves via resolveByPhoneWithCreation (JAK-first-text-welcome).
    // Default: a RETURNING customer (created:false) so the classic tests are unaffected
    // and no welcome fires; the first-contact suite overrides created to true.
    customers.resolveByPhoneWithCreation.mockImplementation(async (phone) => ({
      customer: customerFor(phone),
      created: false,
    }));
    // Report counter + onboarding ask (JAK-first-text-welcome). Default: a low count
    // and a no-op ask-claim, so the delayed ask never fires unless a test drives it.
    customers.incrementReportCount.mockResolvedValue(1);
    customers.markOnboardingAsked.mockResolvedValue(true);
    customers.captureProfile.mockResolvedValue(customerFor("+15559990000"));
    creditSettings.defaultGrant.mockImplementation(async (type) =>
      ({ report: 50, skiptrace: 10, comps: 10 } as Record<string, number>)[type]
    );
    onboardingPrompt.getEffectivePrompt.mockResolvedValue(OnboardingPromptService.DEFAULT_PROMPT);
    // JAK-188: default to the canonical footer so existing reply assertions (which
    // expect the two-line default footer) hold; the swap is then a no-op.
    footers.getRandomActiveFooter.mockResolvedValue(PropertyReportWriter.FOOTER);
    // Per-feature out-of-credits copy (JAK-161): echo the bucket so a test can
    // assert the RIGHT message went out (the sender appends the JAK-158 footer).
    creditSettings.outOfCreditsMessage.mockImplementation(
      async (type) => `You're out of ${type} credits. To get more, contact an admin.`
    );
    credits.hasCreditsForTextLookup.mockResolvedValue(true);
    credits.costOfTextLookup.mockReturnValue(1);
    credits.chargeForTextLookup.mockResolvedValue({ ok: true, balanceAfter: 9, entries: [] });
    gateway.sendSms.mockResolvedValue({ messageId: "gw_m1" });
    gateway.createContactNote.mockResolvedValue({ id: "n1", body: "note" });
    // Default the configured gateway from-number to UNSET ("") — individual tests
    // override it (JAK-force-fromnumber-833). Without this the auto-mocked getter
    // returns a truthy stub, which would leak into the "omit" case.
    (gateway as unknown as { defaultFromNumber: string }).defaultFromNumber = "";
    ghlClient.sendSms.mockResolvedValue({ messageId: "own_m1" });
    ghlClient.createNote.mockResolvedValue({ id: "n2", body: "note" });

    service = new JakeAssistantService(
      realEstate,
      ghlClient,
      gateway,
      connections,
      customers,
      credits,
      creditSettings,
      reportWriter,
      memory,
      orchestrator,
      skipTraceWriter,
      skipTrace,
      skipTraceSettings,
      compsWriter,
      comps,
      compsSettings,
      disambiguation,
      compsEngine,
      onboardingPrompt,
      footers
    );
  });

  describe("gateway mode (default, master key)", () => {
    it("sends the reply + note through the MASTER gateway, never a per-location key", async () => {
      realEstate.searchPropertyByAddress.mockResolvedValue({
        address: "123 Main St, Springfield, IL 62704",
        bedrooms: 3,
      } as never);

      const result = await service.handleInboundMessage({
        contactId: "ct_1",
        senderPhone: "+15559990000",
        message: "123 Main St, Springfield, IL 62704",
      });

      expect(result.mode).toBe("gateway");
      expect(gateway.sendSms).toHaveBeenCalledWith(
        expect.objectContaining({ contactId: "ct_1", message: expect.stringContaining("123 Main St") })
      );
      expect(gateway.createContactNote).toHaveBeenCalledWith("ct_1", expect.stringContaining("looked up"));
      // The per-location (own_number) client is NEVER used in gateway mode.
      expect(ghlClient.sendSms).not.toHaveBeenCalled();
      expect(ghlClient.createNote).not.toHaveBeenCalled();
    });

    it("replies FROM the inbound destination number (mirrors the number texted, JAK-167)", async () => {
      realEstate.searchPropertyByAddress.mockResolvedValue({ address: "1 A St" } as never);

      const result = await service.handleInboundMessage({
        contactId: "ct_1",
        senderPhone: "+15559990000",
        message: "1 A St",
        // The customer texted the NEW toll-free number; the reply must go out from it,
        // not the gateway sub-account's old default number.
        candidateNumbers: ["+18333105253"],
      });

      expect(result.mode).toBe("gateway");
      expect(gateway.sendSms).toHaveBeenCalledWith(
        expect.objectContaining({ contactId: "ct_1", fromNumber: "+18333105253" })
      );
    });

    it("omits fromNumber (GHL default) when the inbound carries no destination number", async () => {
      realEstate.searchPropertyByAddress.mockResolvedValue({ address: "1 A St" } as never);

      await service.handleInboundMessage({
        contactId: "ct_1",
        senderPhone: "+15559990000",
        message: "1 A St",
        // No candidateNumbers → nothing to mirror; preserve prior default-number behavior.
      });

      expect(gateway.sendSms).toHaveBeenCalledWith(
        expect.objectContaining({ contactId: "ct_1", fromNumber: undefined })
      );
    });

    it("falls back to the CONFIGURED gateway from-number when the inbound carries no destination (JAK-force-fromnumber-833)", async () => {
      // GHL's inbound webhook has no destination → candidateNumbers empty. With the
      // configured default set, Jake must still reply from the provisioned toll-free
      // number instead of GHL's (old) sub-account default.
      (gateway as unknown as { defaultFromNumber: string }).defaultFromNumber = "+18333105253";
      realEstate.searchPropertyByAddress.mockResolvedValue({ address: "1 A St" } as never);

      await service.handleInboundMessage({
        contactId: "ct_1",
        senderPhone: "+15559990000",
        message: "1 A St",
        // No candidateNumbers → nothing to mirror; the configured default takes over.
      });

      expect(gateway.sendSms).toHaveBeenCalledWith(
        expect.objectContaining({ contactId: "ct_1", fromNumber: "+18333105253" })
      );
    });

    it("mirrors the inbound destination even when a gateway default is configured (mirror wins)", async () => {
      // Precedence: a real inbound destination always beats the configured default.
      (gateway as unknown as { defaultFromNumber: string }).defaultFromNumber = "+18333105253";
      realEstate.searchPropertyByAddress.mockResolvedValue({ address: "1 A St" } as never);

      await service.handleInboundMessage({
        contactId: "ct_1",
        senderPhone: "+15559990000",
        message: "1 A St",
        candidateNumbers: ["+18449998888"],
      });

      expect(gateway.sendSms).toHaveBeenCalledWith(
        expect.objectContaining({ contactId: "ct_1", fromNumber: "+18449998888" })
      );
    });

    it("used even when a connection exists but is set to text_mode='gateway'", async () => {
      connections.getByLocationId.mockResolvedValue(connection({ textMode: "gateway" }));
      realEstate.searchPropertyByAddress.mockResolvedValue(null);

      const result = await service.handleInboundMessage({
        contactId: "ct_1",
        senderPhone: "+15559990000",
        message: "hi",
        locationId: "loc_a",
      });

      expect(result.mode).toBe("gateway");
      expect(gateway.sendSms).toHaveBeenCalledTimes(1);
      expect(ghlClient.sendSms).not.toHaveBeenCalled();
    });

    it("charges the texting customer's credit account for a delivered lookup", async () => {
      realEstate.searchPropertyByAddress.mockResolvedValue({ address: "1 A St" } as never);

      const result = await service.handleInboundMessage({
        contactId: "ct_1",
        senderPhone: "+15559990000",
        message: "1 A St, Town, CA 90000",
      });

      expect(credits.hasCreditsForTextLookup).toHaveBeenCalledWith("acct_+15559990000");
      expect(credits.chargeForTextLookup).toHaveBeenCalledWith({ accountId: "acct_+15559990000" });
      expect(result.charged).toBe(1);
    });
  });

  describe("two-level hold (JAK-148)", () => {
    it("on_hold: replies the hold notice, runs NO specialist, and charges NOTHING", async () => {
      customers.resolveByPhoneWithCreation.mockResolvedValue({
        customer: { ...customerFor("+15559990000"), status: "on_hold" },
        created: false,
      });
      // A real address would normally run a property_report; on hold it must not.
      realEstate.searchPropertyByAddress.mockResolvedValue({ address: "123 Main St" } as never);

      const result = await service.handleInboundMessage({
        contactId: "ct_1",
        senderPhone: "+15559990000",
        message: "123 Main St, Springfield, IL 62704",
      });

      // Friendly hold notice went back over the gateway.
      expect(result.charged).toBe(0);
      expect(result.reply).toContain("on hold");
      expect(gateway.sendSms).toHaveBeenCalledWith(
        expect.objectContaining({ contactId: "ct_1", message: expect.stringContaining("on hold") })
      );
      // No work: the router never ran, no lookup, no specialist, no charge. The hold
      // is enforced entirely server-side (JAK-remove-ghl-hold) — no GHL write at all.
      expect(orchestrator.plan).not.toHaveBeenCalled();
      expect(realEstate.searchPropertyByAddress).not.toHaveBeenCalled();
      expect(credits.chargeForTextLookup).not.toHaveBeenCalled();
      expect(credits.hasCreditsForTextLookup).not.toHaveBeenCalled();
    });

    it("deactivated: backstop refuses to process/charge if an inbound still arrives", async () => {
      customers.resolveByPhoneWithCreation.mockResolvedValue({
        customer: { ...customerFor("+15559990000"), status: "deactivated" },
        created: false,
      });

      const result = await service.handleInboundMessage({
        contactId: "ct_1",
        senderPhone: "+15559990000",
        message: "742 Evergreen Terrace, Springfield, IL 62704",
      });

      expect(result.charged).toBe(0);
      expect(orchestrator.plan).not.toHaveBeenCalled();
      expect(realEstate.searchPropertyByAddress).not.toHaveBeenCalled();
      expect(credits.chargeForTextLookup).not.toHaveBeenCalled();
    });

    it("active: normal processing resumes — the router runs and a lookup can charge", async () => {
      // Default customerFor is active; a real address routes to a paid report.
      realEstate.searchPropertyByAddress.mockResolvedValue({ address: "1 A St" } as never);

      const result = await service.handleInboundMessage({
        contactId: "ct_1",
        senderPhone: "+15559990000",
        message: "1 A St, Town, CA 90000",
      });

      expect(orchestrator.plan).toHaveBeenCalled();
      expect(result.charged).toBe(1);
    });
  });

  describe("own_number mode (opt-in, per-tenant key + number)", () => {
    it("sends the reply + note through the resolved connection's OWN location", async () => {
      connections.getByLocationId.mockResolvedValue(
        connection({ locationId: "loc_a", textMode: "own_number", phoneNumbers: ["+15551110000"] })
      );
      realEstate.searchPropertyByAddress.mockResolvedValue({ address: "9 B Rd" } as never);

      const result = await service.handleInboundMessage({
        contactId: "ct_1",
        senderPhone: "+15559990000",
        message: "9 B Rd, Town, CA 90000",
        locationId: "loc_a",
        candidateNumbers: ["+15551110000"],
      });

      expect(result.mode).toBe("own_number");
      // Sent on THIS location's per-tenant client, replying from its OWN number.
      expect(ghlClient.sendSms).toHaveBeenCalledWith("loc_a", {
        contactId: "ct_1",
        message: expect.any(String),
        fromNumber: "+15551110000",
      });
      expect(ghlClient.createNote).toHaveBeenCalledWith("loc_a", "ct_1", expect.stringContaining("looked up"));
      // The master gateway is NEVER used in own_number mode.
      expect(gateway.sendSms).not.toHaveBeenCalled();
      expect(gateway.createContactNote).not.toHaveBeenCalled();
    });

    it("omits the reply-from number when it is NOT one of the connection's own numbers", async () => {
      connections.getByLocationId.mockResolvedValue(
        connection({ locationId: "loc_a", textMode: "own_number", phoneNumbers: ["+15551110000"] })
      );
      realEstate.searchPropertyByAddress.mockResolvedValue(null);

      await service.handleInboundMessage({
        contactId: "ct_1",
        senderPhone: "+15559990000",
        message: "hi",
        locationId: "loc_a",
        candidateNumbers: ["+19998887777"], // foreign / attacker-supplied
      });

      expect(ghlClient.sendSms).toHaveBeenCalledWith(
        "loc_a",
        expect.objectContaining({ fromNumber: undefined })
      );
    });

    it("resolves own_number by destination number when no location id is present", async () => {
      connections.getByLocationId.mockResolvedValue(null);
      connections.getByPhoneNumber.mockResolvedValue(
        connection({ locationId: "loc_b", textMode: "own_number", phoneNumbers: ["+15552220000"] })
      );
      realEstate.searchPropertyByAddress.mockResolvedValue(null);

      const result = await service.handleInboundMessage({
        contactId: "ct_1",
        senderPhone: "+15559990000",
        message: "hi",
        candidateNumbers: ["+15552220000"],
      });

      expect(result.mode).toBe("own_number");
      expect(connections.getByPhoneNumber).toHaveBeenCalledWith("+15552220000");
      expect(ghlClient.sendSms).toHaveBeenCalledWith("loc_b", expect.any(Object));
    });

    it("falls back to gateway when the resolved connection is inactive", async () => {
      connections.getByLocationId.mockResolvedValue(
        connection({ status: "inactive", textMode: "own_number" })
      );
      realEstate.searchPropertyByAddress.mockResolvedValue(null);

      const result = await service.handleInboundMessage({
        contactId: "ct_1",
        senderPhone: "+15559990000",
        message: "hi",
        locationId: "loc_a",
      });

      expect(result.mode).toBe("gateway");
      expect(gateway.sendSms).toHaveBeenCalledTimes(1);
      expect(ghlClient.sendSms).not.toHaveBeenCalled();
    });
  });

  describe("billing identity + isolation", () => {
    it("two different senders map to two different credit accounts", async () => {
      realEstate.searchPropertyByAddress.mockResolvedValue({ address: "x" } as never);

      await service.handleInboundMessage({
        contactId: "ct_a",
        senderPhone: "+15550001111",
        message: "1 A St, T, CA 90000",
      });
      await service.handleInboundMessage({
        contactId: "ct_b",
        senderPhone: "+15550002222",
        message: "2 B St, T, CA 90000",
      });

      const chargedAccounts = credits.chargeForTextLookup.mock.calls.map(([c]) => c.accountId);
      expect(chargedAccounts).toEqual(["acct_+15550001111", "acct_+15550002222"]);
    });
  });

  describe("property report data (JAK-130 assembly + derivations)", () => {
    // Capture the VERIFIED data the service hands the writer.
    const dataHandedToWriter = () => reportWriter.write.mock.calls[0]![0];

    it("maps the real fields and DERIVES absentee / occupancy / free-&-clear / equity", async () => {
      realEstate.searchPropertyByAddress.mockResolvedValue({
        address: "742 Evergreen Terrace, Springfield, IL 62704",
        city: "Springfield",
        state: "IL",
        zip: "62704",
        propertyType: "Single Family",
        bedrooms: 4,
        bathrooms: 2,
        squareFeet: 2100,
        lotSquareFeet: 43560, // exactly one acre
        yearBuilt: 1998,
        estimatedValue: 325000,
        owner1FullName: "Homer Simpson",
        owner2FullName: "Marge Simpson",
        lastSaleAmount: 210000,
        lastSaleDate: "2019-05-15",
        yearsOwned: 7, // explicit → deterministic (no dependence on the clock)
        openMortgageBalance: 0, // no open mortgage → Free & Clear, 100% equity
        ownerType: null,
        mailAddress: { state: "CA", city: "Los Angeles" }, // differs from IL/Springfield
        floodZoneDescription: "AE",
        mlsActive: false,
      } as never);

      await service.handleInboundMessage({
        contactId: "ct_1",
        senderPhone: "+15559990000",
        message: "742 Evergreen Terrace, Springfield, IL 62704",
      });

      const data = dataHandedToWriter();
      expect(data).toMatchObject({
        addressLine1: "742 Evergreen Terrace",
        addressLine2: "Springfield, IL 62704",
        propertyType: "Single Family",
        bedrooms: 4,
        bathrooms: 2,
        squareFeet: 2100,
        lotAcres: 1,
        yearBuilt: 1998,
        estimatedMarketValue: 325000,
        owner1: "Homer Simpson",
        owner2: "Marge Simpson",
        equityPercent: 100,
        freeAndClear: true,
        equityLevel: "High Equity",
        occupancy: "Investor-Owned", // mailing state differs from the property
        absenteeStatus: "Out-of-State Absentee Owner",
        yearsOwned: 7,
        lastSoldDate: "05/15/2019", // normalized to MM/DD/YYYY
        salePrice: 210000,
        femaFloodZone: "AE",
        mlsListed: false,
      });
    });

    it("OMITS fields the API didn't return — no null/undefined/blank leaks", async () => {
      realEstate.searchPropertyByAddress.mockResolvedValue({
        address: "9 Sparse Ln, Town, CA 90000",
        bedrooms: 2,
        owner1FullName: "Jane Doe",
        // no owner2, no value, no sale, no flood, no mls, no equity signals
      } as never);

      await service.handleInboundMessage({
        contactId: "ct_1",
        senderPhone: "+15559990000",
        message: "9 Sparse Ln, Town, CA 90000",
      });

      const data = dataHandedToWriter();
      // Present fields only.
      expect(data.addressLine1).toBe("9 Sparse Ln");
      expect(data.owner1).toBe("Jane Doe");
      expect(data.bedrooms).toBe(2);
      // Absent fields must not appear at all (not as null/undefined).
      for (const key of [
        "owner2",
        "estimatedMarketValue",
        "salePrice",
        "lastSoldDate",
        "femaFloodZone",
        "mlsListed",
        "equityPercent",
        "equityLevel",
        "occupancy",
        "absenteeStatus",
        // JAK-132 money + distress fields the API didn't return.
        "estimatedMortgageBalance",
        "estimatedMortgagePayment",
        "estimatedEquity",
        "foreclosure",
        "preForeclosure",
        "reo",
        "auction",
        "auctionDate",
        "taxLien",
        "judgment",
      ]) {
        expect(data).not.toHaveProperty(key);
      }
      // Nothing anywhere is null/undefined.
      expect(Object.values(data).every((v) => v !== null && v !== undefined)).toBe(true);
    });

    it("maps JAK-132 Financials + Distress/Lien flags and hands the FULL record to the writer", async () => {
      const record = {
        address: "742 Evergreen Terrace, Springfield, IL 62704",
        openMortgageBalance: 148000,
        estimatedMortgagePayment: 1350,
        estimatedEquity: 177000,
        preForeclosure: true,
        taxLien: true,
        foreclosure: false, // known-false: mapped through so the report can reassure
        judgment: false,
      };
      realEstate.searchPropertyByAddress.mockResolvedValue(record as never);

      await service.handleInboundMessage({
        contactId: "ct_1",
        senderPhone: "+15559990000",
        message: "742 Evergreen Terrace, Springfield, IL 62704",
      });

      const data = dataHandedToWriter();
      expect(data).toMatchObject({
        estimatedMortgageBalance: 148000,
        estimatedMortgagePayment: 1350,
        estimatedEquity: 177000,
        preForeclosure: true,
        taxLien: true,
        foreclosure: false,
        judgment: false,
      });
      // Liens are FLAGS — never a fabricated dollar amount.
      expect(data).not.toHaveProperty("estimatedLiens");

      // The COMPLETE raw record rides along as the writer's second argument so the
      // LLM path sees every field, not just the curated subset.
      const rawHandedToWriter = reportWriter.write.mock.calls[0]![1];
      expect(rawHandedToWriter).toBe(record);
    });
  });

  describe("credit gate + no-charge paths", () => {
    it("out of credits: sends a notice, writes a note, and does NOT charge", async () => {
      credits.hasCreditsForTextLookup.mockResolvedValue(false);

      const result = await service.handleInboundMessage({
        contactId: "ct_1",
        senderPhone: "+15559990000",
        message: "123 Main St, Springfield, IL 62704",
      });

      expect(result.outOfCredits).toBe(true);
      expect(result.charged).toBe(0);
      expect(realEstate.searchPropertyByAddress).not.toHaveBeenCalled();
      expect(credits.chargeForTextLookup).not.toHaveBeenCalled();
      expect(gateway.createContactNote).toHaveBeenCalledWith("ct_1", expect.stringContaining("out of report credits"));
    });

    it("no address: guidance reply, no lookup, no charge", async () => {
      const result = await service.handleInboundMessage({
        contactId: "ct_1",
        senderPhone: "+15559990000",
        message: "hey",
      });

      expect(result.address).toBeNull();
      expect(result.charged).toBe(0);
      expect(realEstate.searchPropertyByAddress).not.toHaveBeenCalled();
      expect(credits.chargeForTextLookup).not.toHaveBeenCalled();
    });

    it("no property match: replies, writes a 'no match' note, no charge", async () => {
      realEstate.searchPropertyByAddress.mockResolvedValue(null);

      const result = await service.handleInboundMessage({
        contactId: "ct_1",
        senderPhone: "+15559990000",
        message: "123 Nowhere Rd, Town, CA 90000",
      });

      expect(result.charged).toBe(0);
      expect(credits.chargeForTextLookup).not.toHaveBeenCalled();
      expect(gateway.createContactNote).toHaveBeenCalledWith("ct_1", expect.stringContaining("no property match"));
      // No match ⇒ nothing to cache for a free re-serve.
      expect(memory.recordLookup).not.toHaveBeenCalled();
    });
  });

  // ── JAK-134: conversation memory + lookup cache + free re-serve ─────────────
  describe("conversation memory (JAK-134)", () => {
    it("persists EVERY inbound message with the resolved address", async () => {
      realEstate.searchPropertyByAddress.mockResolvedValue({ address: "1 A St" } as never);

      await service.handleInboundMessage({
        contactId: "ct_1",
        senderPhone: "+15559990000",
        message: "123 Main St, Springfield, IL 62704",
      });

      expect(memory.appendInbound).toHaveBeenCalledWith(
        expect.objectContaining({
          phone: "+15559990000",
          body: "123 Main St, Springfield, IL 62704",
          resolvedAddress: "123 Main St, Springfield, IL 62704",
        })
      );
    });

    it("persists a non-address inbound with resolvedAddress = null", async () => {
      await service.handleInboundMessage({
        contactId: "ct_1",
        senderPhone: "+15559990000",
        message: "hey there",
      });

      expect(memory.appendInbound).toHaveBeenCalledWith(
        expect.objectContaining({ body: "hey there", resolvedAddress: null })
      );
    });
  });

  describe("cache MISS → paid lookup is snapshotted (JAK-134)", () => {
    it("looks up, charges, and records the snapshot for a future free re-serve", async () => {
      const record = { id: 987, address: "123 Main St, Springfield, IL 62704" };
      realEstate.searchPropertyByAddress.mockResolvedValue(record as never);

      const result = await service.handleInboundMessage({
        contactId: "ct_1",
        senderPhone: "+15559990000",
        message: "123 Main St, Springfield, IL 62704",
      });

      expect(memory.checkCache).toHaveBeenCalledWith("+15559990000", "123 Main St, Springfield, IL 62704");
      expect(realEstate.searchPropertyByAddress).toHaveBeenCalledWith("123 Main St, Springfield, IL 62704");
      expect(credits.chargeForTextLookup).toHaveBeenCalledWith({ accountId: "acct_+15559990000" });
      expect(result.charged).toBe(1);
      // The whole record + the exact reply text are snapshotted (report id as string).
      expect(memory.recordLookup).toHaveBeenCalledWith(
        expect.objectContaining({
          normalizedAddress: "123 Main St, Springfield, IL 62704",
          propertyId: "987",
          propertyRecord: record,
          reportText: expect.stringContaining("Jake Property Report"),
        })
      );
    });
  });

  describe("cache HIT → FREE re-serve, no paid API, no charge (JAK-134)", () => {
    it("re-serves the stored report for free and invites an OK refresh", async () => {
      memory.checkCache.mockResolvedValue(lookupRow());

      const result = await service.handleInboundMessage({
        contactId: "ct_1",
        senderPhone: "+15559990000",
        message: "123 Main St, Springfield, IL 62704",
      });

      // Dev no-spend / free-reserve: the PAID API is NEVER called and NOTHING is charged.
      expect(realEstate.searchPropertyByAddress).not.toHaveBeenCalled();
      expect(credits.chargeForTextLookup).not.toHaveBeenCalled();
      // The LLM writer is not re-run either — the STORED report is served verbatim.
      expect(reportWriter.write).not.toHaveBeenCalled();
      expect(result.charged).toBe(0);
      expect(result.reserved).toBe(true);

      // The reply is the stored report + the free-re-serve notice, footer LAST.
      const sent = (gateway.sendSms.mock.calls[0]![0] as { message: string }).message;
      expect(sent).toContain("123 Main St");
      expect(sent).toContain("already on record");
      // JAK-silent-credits-intro: OK still fetches a fresh copy, but NO credit price is shown.
      expect(sent).toMatch(/reply ok for a fresh copy\./i);
      expect(sent.toLowerCase()).not.toContain("credit");
      expect(sent.endsWith("Every Lead Deserves Jake.\nGoTextJake.com/CRM")).toBe(true);
      // No emojis in the re-served copy.
      expect(sent).not.toMatch(/\p{Extended_Pictographic}/u);
    });

    it("re-serves for free EVEN when the customer is out of credits", async () => {
      memory.checkCache.mockResolvedValue(lookupRow());
      credits.hasCreditsForTextLookup.mockResolvedValue(false);

      const result = await service.handleInboundMessage({
        contactId: "ct_1",
        senderPhone: "+15559990000",
        message: "123 Main St, Springfield, IL 62704",
      });

      expect(result.reserved).toBe(true);
      expect(result.outOfCredits).toBeUndefined();
      expect(realEstate.searchPropertyByAddress).not.toHaveBeenCalled();
    });
  });

  describe("OK reply → fresh PAID copy of the last address (JAK-134)", () => {
    it("charges and refreshes the last resolved address", async () => {
      memory.lastResolvedAddress.mockResolvedValue("742 Evergreen Terrace, Springfield, IL 62704");
      realEstate.searchPropertyByAddress.mockResolvedValue({ id: 42, address: "742 Evergreen Terrace" } as never);

      const result = await service.handleInboundMessage({
        contactId: "ct_1",
        senderPhone: "+15559990000",
        message: "OK",
      });

      expect(memory.lastResolvedAddress).toHaveBeenCalledWith("+15559990000");
      // "OK" carries no address, so the cache is not consulted — this is a paid refresh.
      expect(memory.checkCache).not.toHaveBeenCalled();
      expect(realEstate.searchPropertyByAddress).toHaveBeenCalledWith(
        "742 Evergreen Terrace, Springfield, IL 62704"
      );
      expect(credits.chargeForTextLookup).toHaveBeenCalledWith({ accountId: "acct_+15559990000" });
      expect(result.charged).toBe(1);
      expect(result.refreshed).toBe(true);
      expect(memory.recordLookup).toHaveBeenCalledTimes(1);
    });

    it("falls back to guidance when there is no prior address to refresh", async () => {
      memory.lastResolvedAddress.mockResolvedValue(null);

      const result = await service.handleInboundMessage({
        contactId: "ct_1",
        senderPhone: "+15559990000",
        message: "ok",
      });

      expect(result.address).toBeNull();
      expect(result.charged).toBe(0);
      expect(realEstate.searchPropertyByAddress).not.toHaveBeenCalled();
      expect(credits.chargeForTextLookup).not.toHaveBeenCalled();
    });
  });

  // ── JAK-135: orchestrated dispatch (router → plan → specialist) ─────────────
  describe("orchestrated dispatch (JAK-135)", () => {
    it("routes every inbound through the orchestrator and surfaces the intent", async () => {
      realEstate.searchPropertyByAddress.mockResolvedValue({ address: "1 A St" } as never);

      const result = await service.handleInboundMessage({
        contactId: "ct_1",
        senderPhone: "+15559990000",
        message: "123 Main St, Springfield, IL 62704",
      });

      expect(orchestrator.plan).toHaveBeenCalledWith(
        expect.objectContaining({
          phone: "+15559990000",
          message: "123 Main St, Springfield, IL 62704",
          parsedAddress: "123 Main St, Springfield, IL 62704",
          isAffirmative: false,
        })
      );
      expect(result.intent).toBe("property_report");
    });

    it("reference-resolved report: runs the Report specialist on the RESOLVED target address", async () => {
      // The router resolved "the owner for the 2nd address I sent" to a concrete
      // address that never appears in this message — the executor must look up THAT.
      orchestrator.plan.mockResolvedValue({
        intent: "property_report",
        targetEntity: "742 Evergreen Terrace, Springfield, IL 62704",
        specialists: reportSpecialist(),
        userFacingNote: "Looking up the 2nd address you sent.",
      });
      realEstate.searchPropertyByAddress.mockResolvedValue({ id: 7, address: "742 Evergreen Terrace" } as never);

      const result = await service.handleInboundMessage({
        contactId: "ct_1",
        senderPhone: "+15559990000",
        message: "who owns the 2nd address I sent?",
      });

      expect(memory.checkCache).toHaveBeenCalledWith("+15559990000", "742 Evergreen Terrace, Springfield, IL 62704");
      expect(realEstate.searchPropertyByAddress).toHaveBeenCalledWith("742 Evergreen Terrace, Springfield, IL 62704");
      expect(result.intent).toBe("property_report");
      expect(result.charged).toBe(1);
    });

    it("property_report with an UNRESOLVABLE reference (null target) → guidance, no spend", async () => {
      orchestrator.plan.mockResolvedValue({
        intent: "property_report",
        targetEntity: null,
        specialists: reportSpecialist(),
        userFacingNote: "",
      });

      const result = await service.handleInboundMessage({
        contactId: "ct_1",
        senderPhone: "+15559990000",
        message: "the 9th one",
      });

      expect(result.address).toBeNull();
      expect(result.charged).toBe(0);
      expect(realEstate.searchPropertyByAddress).not.toHaveBeenCalled();
      expect(credits.chargeForTextLookup).not.toHaveBeenCalled();
    });

    it("chitchat intent → guidance reply, emoji-free with the footer, no spend", async () => {
      orchestrator.plan.mockResolvedValue({
        intent: "chitchat",
        targetEntity: null,
        specialists: [],
        userFacingNote: "",
      });

      const result = await service.handleInboundMessage({
        contactId: "ct_1",
        senderPhone: "+15559990000",
        message: "hey jake, how's it going?",
      });

      expect(result.intent).toBe("chitchat");
      expect(result.charged).toBe(0);
      expect(realEstate.searchPropertyByAddress).not.toHaveBeenCalled();
      const sent = (gateway.sendSms.mock.calls[0]![0] as { message: string }).message;
      expect(sent.endsWith("Every Lead Deserves Jake.\nGoTextJake.com/CRM")).toBe(true);
      expect(sent).not.toMatch(/\p{Extended_Pictographic}/u);
    });
  });

  // ── Skip trace (JAK-136): credit-gated, confirm-before-spend, cache/free-reserve.
  describe("skip trace (JAK-136)", () => {
    const TARGET = "742 Evergreen Terrace, Springfield, IL 62704";
    const skipTracePlan = (targetEntity: string | null = TARGET): DispatchPlan => ({
      intent: "skip_trace",
      targetEntity,
      specialists: skipTraceSpecialist(),
      userFacingNote: "",
    });
    // A paid run sends a brief ack first (JAK-138), so read the tail rather than call[0].
    const sent = () => (gateway.sendSms.mock.calls.at(-1)![0] as { message: string }).message;

    // JAK-144: the live provider returns matches at the top level under persons[].
    const personsHit = {
      match: true,
      persons: [
        { fullName: "Homer Simpson", phones: [{ phone: "+15550101" }], emails: ["homer@example.com"] },
      ],
    };

    it("JAK-145: traces the OWNER (name + address), charges on success, snapshots per-person", async () => {
      orchestrator.plan.mockResolvedValue(skipTracePlan());
      // JAK-145: the default flow pulls the owner from PropertySearch and passes the
      // owner NAME alongside the address — not just the address's top resident.
      realEstate.searchPropertyByAddress.mockResolvedValue({
        owner1FirstName: "Homer",
        owner1LastName: "Simpson",
      } as never);
      realEstate.skipTraceByAddress.mockResolvedValue(personsHit as never);

      const result = await service.handleInboundMessage({
        contactId: "ct_1",
        senderPhone: "+15559990000",
        message: "skip trace 742 Evergreen Terrace",
      });

      // Ran on the first ask — NO confirmation step, NO pending offer — and passed
      // the resolved owner name to the trace (JAK-145 Part A).
      expect(realEstate.skipTraceByAddress).toHaveBeenCalledWith(TARGET, {
        firstName: "Homer",
        lastName: "Simpson",
      });
      // Cache/free-reserve is keyed per (address + resolved person), not address alone.
      expect(skipTrace.checkCache).toHaveBeenCalledWith("+15559990000", TARGET, "homer simpson");
      expect(skipTrace.recordTrace).toHaveBeenCalledWith(
        expect.objectContaining({ subjectKey: "homer simpson" })
      );
      expect(skipTrace.setPending).not.toHaveBeenCalled();
      // The top-level persons[] (JAK-144 live shape) is parsed into the verified
      // data handed to the writer — owner name, phones, and emails.
      expect(skipTraceWriter.write).toHaveBeenCalledWith(
        expect.objectContaining({
          ownerName: "Homer Simpson",
          phones: ["+15550101"],
          emails: ["homer@example.com"],
        }),
        expect.anything()
      );
      // Charged EXACTLY the cost, to the texting customer's account, on a hit.
      expect(credits.chargeForSkipTrace).toHaveBeenCalledWith({
        accountId: "acct_+15559990000",
        credits: 3,
      });
      expect(result.charged).toBe(3);
      expect(skipTrace.recordTrace).toHaveBeenCalled();
      expect(sent()).toContain("Homer Simpson");
      // No "reply OK" prompt anymore.
      expect(sent().toLowerCase()).not.toContain("reply ok");
      expect(sent().endsWith("Every Lead Deserves Jake.\nGoTextJake.com/CRM")).toBe(true);
      expect(sent()).not.toMatch(/\p{Extended_Pictographic}/u);
    });

    it("JAK-145 Part B: traces the PEOPLE the texter named, keyed per person, no owner fetch", async () => {
      // "skip trace Marge and Homer" — the router extracts the named people. Fictional
      // personas only; the scenario mirrors the live 'skip trace the two owners' ask.
      orchestrator.plan.mockResolvedValue({ ...skipTracePlan(), personNames: ["Marge", "Homer"] });
      realEstate.skipTraceByAddress.mockResolvedValue(personsHit as never);

      await service.handleInboundMessage({
        contactId: "ct_1",
        senderPhone: "+15559990000",
        message: "skip trace Marge and Homer",
      });

      // The FIRST named person's name goes to the provider (address for context).
      expect(realEstate.skipTraceByAddress).toHaveBeenCalledWith(TARGET, {
        firstName: "Marge",
        lastName: null,
      });
      // A named-person request never pays for an owner PropertySearch.
      expect(realEstate.searchPropertyByAddress).not.toHaveBeenCalled();
      // Keyed on the named people (sorted, order-independent) — NOT address alone.
      expect(skipTrace.checkCache).toHaveBeenCalledWith("+15559990000", TARGET, "homer|marge");
      expect(skipTrace.recordTrace).toHaveBeenCalledWith(
        expect.objectContaining({ subjectKey: "homer|marge" })
      );
    });

    it("JAK-145 Part C: hands the writer contacts GROUPED per person", async () => {
      orchestrator.plan.mockResolvedValue(skipTracePlan());
      // Two matched people at the address, each with their own numbers/emails.
      realEstate.skipTraceByAddress.mockResolvedValue({
        match: true,
        persons: [
          { fullName: "Ned Flanders", phones: [{ phone: "+15550001" }], emails: ["ned@example.com"] },
          { fullName: "Maude Flanders", phones: [{ phone: "+15550002" }], emails: ["maude@example.com"] },
        ],
      } as never);

      await service.handleInboundMessage({
        contactId: "ct_1",
        senderPhone: "+15559990000",
        message: "skip trace 742 Evergreen Terrace",
      });

      const data = skipTraceWriter.write.mock.calls.at(-1)![0];
      expect(data.persons).toEqual([
        { name: "Ned Flanders", phones: ["+15550001"], emails: ["ned@example.com"] },
        { name: "Maude Flanders", phones: ["+15550002"], emails: ["maude@example.com"] },
      ]);
    });

    it("JAK-145 Part D: a DIFFERENT person at the same address is a NEW lookup (no cache collision)", async () => {
      // Owner-default trace and a named-person trace at the SAME address resolve to
      // DIFFERENT cache keys, so the named request can't be served the owner's cached
      // result (the live 'ask for the other owner returns the cached first person' bug).
      realEstate.searchPropertyByAddress.mockResolvedValue({
        owner1FirstName: "Homer",
        owner1LastName: "Simpson",
      } as never);
      realEstate.skipTraceByAddress.mockResolvedValue(personsHit as never);

      orchestrator.plan.mockResolvedValue(skipTracePlan());
      await service.handleInboundMessage({
        contactId: "ct_1",
        senderPhone: "+15559990000",
        message: "skip trace 742 Evergreen Terrace",
      });

      orchestrator.plan.mockResolvedValue({ ...skipTracePlan(), personNames: ["Marge Simpson"] });
      await service.handleInboundMessage({
        contactId: "ct_1",
        senderPhone: "+15559990000",
        message: "what about Marge Simpson the co-owner?",
      });

      const keys = skipTrace.checkCache.mock.calls.map((c) => c[2]);
      expect(keys).toContain("homer simpson"); // owner default
      expect(keys).toContain("marge simpson"); // the named person — a distinct slot
    });

    it("JAK-145 Part D: a repeat of the SAME resolved person re-serves FREE", async () => {
      realEstate.searchPropertyByAddress.mockResolvedValue({
        owner1FirstName: "Homer",
        owner1LastName: "Simpson",
      } as never);
      // The same owner is already on record for this (address + person) key.
      skipTrace.checkCache.mockResolvedValue(skipTraceRow({ target_key: "742 evergreen terrace::homer simpson" }));
      orchestrator.plan.mockResolvedValue(skipTracePlan());

      const result = await service.handleInboundMessage({
        contactId: "ct_1",
        senderPhone: "+15559990000",
        message: "skip trace 742 Evergreen Terrace again",
      });

      expect(result.reserved).toBe(true);
      expect(result.charged).toBe(0);
      expect(realEstate.skipTraceByAddress).not.toHaveBeenCalled();
      expect(skipTrace.checkCache).toHaveBeenCalledWith("+15559990000", TARGET, "homer simpson");
    });

    it("insufficient credits → clear no-charge message, does NOT run, NO paid API", async () => {
      orchestrator.plan.mockResolvedValue(skipTracePlan());
      credits.hasCreditsForSkipTrace.mockResolvedValue(false);
      credits.getBalance.mockResolvedValue(1);

      const result = await service.handleInboundMessage({
        contactId: "ct_1",
        senderPhone: "+15559990000",
        message: "skip trace 742 Evergreen Terrace",
      });

      expect(result.charged).toBe(0);
      expect(result.outOfCredits).toBe(true);
      expect(skipTrace.setPending).not.toHaveBeenCalled();
      expect(realEstate.skipTraceByAddress).not.toHaveBeenCalled();
      expect(credits.chargeForSkipTrace).not.toHaveBeenCalled();
      // JAK-161: the admin-editable SKIPTRACE out-of-credits message (bucket-specific).
      expect(sent()).toContain("out of skiptrace credits");
      expect(sent().endsWith("Every Lead Deserves Jake.\nGoTextJake.com/CRM")).toBe(true);
    });

    it("a run that finds NO contact info → no charge, no snapshot", async () => {
      orchestrator.plan.mockResolvedValue(skipTracePlan());
      realEstate.skipTraceByAddress.mockResolvedValue(null);

      const result = await service.handleInboundMessage({
        contactId: "ct_1",
        senderPhone: "+15559990000",
        message: "skip trace 742 Evergreen Terrace",
      });

      expect(realEstate.skipTraceByAddress).toHaveBeenCalledWith(TARGET);
      expect(credits.chargeForSkipTrace).not.toHaveBeenCalled();
      expect(result.charged).toBe(0);
      expect(skipTrace.recordTrace).not.toHaveBeenCalled();
      expect(sent().toLowerCase()).toContain("couldn't find");
      expect(sent().endsWith("Every Lead Deserves Jake.\nGoTextJake.com/CRM")).toBe(true);
    });

    it("repeat trace within the free window → FREE re-serve, NO paid API, NO charge, NO prompt", async () => {
      orchestrator.plan.mockResolvedValue(skipTracePlan());
      skipTrace.checkCache.mockResolvedValue(skipTraceRow());

      const result = await service.handleInboundMessage({
        contactId: "ct_1",
        senderPhone: "+15559990000",
        message: "skip trace 742 Evergreen Terrace again",
      });

      expect(result.reserved).toBe(true);
      expect(result.charged).toBe(0);
      expect(realEstate.skipTraceByAddress).not.toHaveBeenCalled();
      expect(credits.chargeForSkipTrace).not.toHaveBeenCalled();
      // Free copy re-served verbatim with an "on record, free" note — NO OK prompt.
      expect(sent()).toContain("Homer Simpson");
      expect(sent().toLowerCase()).toContain("already on record");
      expect(sent().toLowerCase()).not.toContain("reply ok");
      expect(sent().endsWith("Every Lead Deserves Jake.\nGoTextJake.com/CRM")).toBe(true);
      // No pending offer is ever parked now.
      expect(skipTrace.setPending).not.toHaveBeenCalled();
    });

    it("no address to trace → guidance, no charge, no run", async () => {
      orchestrator.plan.mockResolvedValue(skipTracePlan(null));
      memory.lastResolvedAddress.mockResolvedValue(null);

      const result = await service.handleInboundMessage({
        contactId: "ct_1",
        senderPhone: "+15559990000",
        message: "skip trace the owner",
      });

      expect(result.charged).toBe(0);
      expect(realEstate.skipTraceByAddress).not.toHaveBeenCalled();
      expect(skipTrace.setPending).not.toHaveBeenCalled();
      expect(skipTrace.checkCache).not.toHaveBeenCalled();
    });

    it("no explicit target falls back to the last resolved address and runs it", async () => {
      orchestrator.plan.mockResolvedValue(skipTracePlan(null));
      memory.lastResolvedAddress.mockResolvedValue("9 B Rd, Town, CA 90000");
      realEstate.skipTraceByAddress.mockResolvedValue(personsHit as never);

      await service.handleInboundMessage({
        contactId: "ct_1",
        senderPhone: "+15559990000",
        message: "skip trace it",
      });

      // Owner unresolved here (no cache, no PropertySearch match) → address-only key
      // and an address-only trace, exactly as before.
      expect(skipTrace.checkCache).toHaveBeenCalledWith("+15559990000", "9 B Rd, Town, CA 90000", "");
      expect(realEstate.skipTraceByAddress).toHaveBeenCalledWith("9 B Rd, Town, CA 90000");
    });

    it("JAK-159: 'skip the last one' traces the MOST-RECENT address, not the stale ordinal-list end", async () => {
      // The router flagged a "last" reference (addressRecency), leaving targetEntity
      // null and carrying a STALE ordinal that points at the OLDEST address (first in
      // the first-appearance list). addressRecency must win: the trace runs on the
      // genuinely most-recent address, not the ordinal's target.
      orchestrator.plan.mockResolvedValue({
        ...skipTracePlan(null),
        addressOrdinal: 1, // stale: end-of-list / first-appearance would mis-target
        addressRecency: "last",
      });
      memory.resolvedAddressList.mockResolvedValue(["1 Old St, Town, CA 90000", "2 Mid Ave, Town, CA 90000"]);
      memory.lastResolvedAddress.mockResolvedValue("3 Newest Blvd, Town, CA 90000");
      realEstate.skipTraceByAddress.mockResolvedValue(personsHit as never);

      await service.handleInboundMessage({
        contactId: "ct_1",
        senderPhone: "+15559990000",
        message: "skip the last one",
      });

      expect(realEstate.skipTraceByAddress).toHaveBeenCalledWith("3 Newest Blvd, Town, CA 90000");
      expect(realEstate.skipTraceByAddress).not.toHaveBeenCalledWith("1 Old St, Town, CA 90000");
    });

    // JAK-145: /v2/SkipTrace is ADDRESS-DOMINANT — it returns the current residents of
    // whatever address we pass and ignores the owner name (live-verified). So for an
    // ABSENTEE property the property address returns TENANTS, never the owner; the
    // owner's tax MAILING address is what reaches the owner (a clean absentee owner
    // returned as the top match at their mailing address in the live diagnosis). These
    // use recorded-SHAPE fixtures (fictional personas, no live calls). The property
    // address stays the report header + cache key; only the queried address changes.
    describe("JAK-145: absentee owner → trace the MAILING address", () => {
      // Owner-occupied is `false` and the mailing address differs from the property.
      const absenteeRecord = {
        owner1FirstName: "Homer",
        owner1LastName: "Simpson",
        ownerOccupied: false,
        mailAddress: { address: "1 Retreat Rd", city: "Shelbyville", state: "IL", zip: "62565" },
      };
      const MAILING = "1 Retreat Rd, Shelbyville IL 62565";

      it("traces the owner's MAILING address (not the property) and reaches the owner", async () => {
        orchestrator.plan.mockResolvedValue(skipTracePlan());
        realEstate.searchPropertyByAddress.mockResolvedValue(absenteeRecord as never);
        realEstate.skipTraceByAddress.mockResolvedValue(personsHit as never);

        const result = await service.handleInboundMessage({
          contactId: "ct_1",
          senderPhone: "+15559990000",
          message: "skip trace 742 Evergreen Terrace",
        });

        // Queried the owner's MAILING address, carrying the owner name.
        expect(realEstate.skipTraceByAddress).toHaveBeenCalledWith(MAILING, {
          firstName: "Homer",
          lastName: "Simpson",
        });
        // The mailing trace returned contact info, so NO property-address fallback.
        expect(realEstate.skipTraceByAddress).toHaveBeenCalledTimes(1);
        // Cache/report still keyed on the PROPERTY address + owner identity — the trace
        // address is an implementation detail, not part of the cache key.
        expect(skipTrace.checkCache).toHaveBeenCalledWith("+15559990000", TARGET, "homer simpson");
        expect(skipTrace.recordTrace).toHaveBeenCalledWith(
          expect.objectContaining({ normalizedTarget: TARGET, subjectKey: "homer simpson" })
        );
        expect(result.charged).toBe(3);
        expect(sent()).toContain("Homer Simpson");
      });

      it("OWNER-OCCUPANT (mailing == property) falls back to the PROPERTY address", async () => {
        orchestrator.plan.mockResolvedValue(skipTracePlan());
        realEstate.searchPropertyByAddress.mockResolvedValue({
          owner1FirstName: "Homer",
          owner1LastName: "Simpson",
          // No ownerOccupied flag — the mailing address EQUALS the property address, so
          // the address comparison alone must resolve to owner-occupied (trace property).
          mailAddress: { address: "742 Evergreen Terrace", city: "Springfield", state: "IL", zip: "62704" },
        } as never);
        realEstate.skipTraceByAddress.mockResolvedValue(personsHit as never);

        await service.handleInboundMessage({
          contactId: "ct_1",
          senderPhone: "+15559990000",
          message: "skip trace 742 Evergreen Terrace",
        });

        // Owner-occupant → the PROPERTY address is traced, exactly once, never a mailing.
        expect(realEstate.skipTraceByAddress).toHaveBeenCalledWith(TARGET, {
          firstName: "Homer",
          lastName: "Simpson",
        });
        expect(realEstate.skipTraceByAddress).toHaveBeenCalledTimes(1);
      });

      it("an absentee MAILING trace that finds NOBODY falls back to the PROPERTY address", async () => {
        orchestrator.plan.mockResolvedValue(skipTracePlan());
        realEstate.searchPropertyByAddress.mockResolvedValue(absenteeRecord as never);
        // Mailing address returns no contact (stale / PO box); the property address does.
        realEstate.skipTraceByAddress
          .mockResolvedValueOnce(null as never)
          .mockResolvedValueOnce(personsHit as never);

        const result = await service.handleInboundMessage({
          contactId: "ct_1",
          senderPhone: "+15559990000",
          message: "skip trace 742 Evergreen Terrace",
        });

        // First the mailing address, then the property-address fallback — both with the name.
        expect(realEstate.skipTraceByAddress).toHaveBeenNthCalledWith(1, MAILING, {
          firstName: "Homer",
          lastName: "Simpson",
        });
        expect(realEstate.skipTraceByAddress).toHaveBeenNthCalledWith(2, TARGET, {
          firstName: "Homer",
          lastName: "Simpson",
        });
        // The fallback delivered contact info → charged, and the owner is in the reply.
        expect(result.charged).toBe(3);
        expect(sent()).toContain("Homer Simpson");
      });
    });
  });

  // ── Comps / CMA (JAK-137): credit-gated, confirm-before-spend, tunable params,
  //    cache/free-reserve keyed by (phone + address + param-set).
  describe("comps (JAK-137)", () => {
    const TARGET = "742 Evergreen Terrace, Springfield, IL 62704";
    const compsPlan = (
      over: Partial<DispatchPlan> = {}
    ): DispatchPlan => ({
      intent: "comps",
      targetEntity: TARGET,
      specialists: compsSpecialist(),
      userFacingNote: "",
      compParams: null,
      ...over,
    });
    // A paid run sends a brief ack first (JAK-138), so read the tail rather than call[0].
    const sent = () => (gateway.sendSms.mock.calls.at(-1)![0] as { message: string }).message;

    // JAK-144: a normalized comps response (comps + subject) from the DAO.
    const compsHit = {
      comps: [{ address: "123 Nearby St", lastSaleAmount: 400000, bedrooms: 3, bathrooms: 2, squareFeet: 1500 }],
      subject: { bedrooms: 3, bathrooms: 2, squareFeet: 1500 },
    };

    it("JAK-144: runs the paid comps IMMEDIATELY (no OK), charges on success, states the params", async () => {
      orchestrator.plan.mockResolvedValue(compsPlan());
      realEstate.getCompsByAddress.mockResolvedValue(compsHit as never);

      const result = await service.handleInboundMessage({
        contactId: "ct_1",
        senderPhone: "+15559990000",
        message: "comps for 742 Evergreen Terrace",
      });

      // Ran on the first ask with the resolved params — NO confirmation, NO pending.
      // JAK-164: the selection engine (radius pool + selection) is the paid path now.
      expect(compsEngine.buildComps).toHaveBeenCalledWith({ target: TARGET, params: DEFAULT_COMP_PARAMS });
      expect(comps.setPending).not.toHaveBeenCalled();
      // The normalized comps response is parsed into the verified data handed to the
      // writer — comp address + sale price.
      expect(compsWriter.write).toHaveBeenCalledWith(
        expect.objectContaining({
          comps: expect.arrayContaining([
            expect.objectContaining({ address: "123 Nearby St", salePrice: 400000 }),
          ]),
        })
      );
      expect(credits.chargeForComps).toHaveBeenCalledWith({ accountId: "acct_+15559990000", credits: 3 });
      expect(result.charged).toBe(3);
      expect(comps.recordComps).toHaveBeenCalled();
      expect(sent().toLowerCase()).not.toContain("reply ok");
      expect(sent().endsWith("Every Lead Deserves Jake.\nGoTextJake.com/CRM")).toBe(true);
      expect(sent()).not.toMatch(/\p{Extended_Pictographic}/u);
    });

    it("applies the texter's parameter overrides (merged onto defaults) when running", async () => {
      orchestrator.plan.mockResolvedValue(compsPlan({ compParams: { radiusMiles: 1, monthsBack: 6, count: 3 } }));
      realEstate.getCompsByAddress.mockResolvedValue(compsHit as never);

      await service.handleInboundMessage({
        contactId: "ct_1",
        senderPhone: "+15559990000",
        message: "comps within 1 mile, last 6 months, 3 similar homes",
      });

      expect(compsEngine.buildComps).toHaveBeenCalledWith({
        target: TARGET,
        params: { radiusMiles: 1, count: 3, monthsBack: 6, bedsTolerance: 1, bathsTolerance: 1, sqftTolerancePct: 25 },
      });
    });

    it("clamps out-of-range texter overrides to sane bounds when running", async () => {
      orchestrator.plan.mockResolvedValue(compsPlan({ compParams: { radiusMiles: 500, count: 999 } }));
      realEstate.getCompsByAddress.mockResolvedValue(compsHit as never);

      await service.handleInboundMessage({
        contactId: "ct_1",
        senderPhone: "+15559990000",
        message: "comps within 500 miles, 999 homes",
      });

      expect(compsEngine.buildComps).toHaveBeenCalledWith({
        target: TARGET,
        params: expect.objectContaining({ radiusMiles: 10, count: 10 }),
      });
    });

    it("insufficient credits → clear no-charge message, does NOT run, NO paid API", async () => {
      orchestrator.plan.mockResolvedValue(compsPlan());
      credits.hasCreditsForComps.mockResolvedValue(false);
      credits.getBalance.mockResolvedValue(1);

      const result = await service.handleInboundMessage({
        contactId: "ct_1",
        senderPhone: "+15559990000",
        message: "comps for 742 Evergreen Terrace",
      });

      expect(result.charged).toBe(0);
      expect(result.outOfCredits).toBe(true);
      expect(comps.setPending).not.toHaveBeenCalled();
      expect(compsEngine.buildComps).not.toHaveBeenCalled();
      expect(credits.chargeForComps).not.toHaveBeenCalled();
      // JAK-161: the admin-editable COMPS out-of-credits message (bucket-specific).
      expect(sent()).toContain("out of comps credits");
      expect(sent().endsWith("Every Lead Deserves Jake.\nGoTextJake.com/CRM")).toBe(true);
    });

    it("a run that finds NO comparable sales → no charge, no snapshot", async () => {
      orchestrator.plan.mockResolvedValue(compsPlan());
      compsEngine.buildComps.mockResolvedValue({
        data: {
          params: DEFAULT_COMP_PARAMS,
          paramsSummary: "radius 1 mi, up to 5 comps, sold in the last 12 months, beds ±1, baths ±1, sqft ±25%",
          subjectAddress: TARGET,
          comps: [],
        } as CompsData,
        record: { source: "none" },
        source: "none",
        selectionMode: "none",
        poolSize: 0,
        usableSize: 0,
      });

      const result = await service.handleInboundMessage({
        contactId: "ct_1",
        senderPhone: "+15559990000",
        message: "comps for 742 Evergreen Terrace",
      });

      expect(compsEngine.buildComps).toHaveBeenCalledWith({ target: TARGET, params: DEFAULT_COMP_PARAMS });
      expect(credits.chargeForComps).not.toHaveBeenCalled();
      expect(result.charged).toBe(0);
      expect(comps.recordComps).not.toHaveBeenCalled();
      expect(sent().toLowerCase()).toContain("couldn't find");
      expect(sent().endsWith("Every Lead Deserves Jake.\nGoTextJake.com/CRM")).toBe(true);
    });

    it("repeat request (same address + params) within the free window → FREE re-serve, NO paid API, NO charge, NO prompt", async () => {
      orchestrator.plan.mockResolvedValue(compsPlan());
      comps.checkCache.mockResolvedValue(compsRow());

      const result = await service.handleInboundMessage({
        contactId: "ct_1",
        senderPhone: "+15559990000",
        message: "comps for 742 Evergreen Terrace again",
      });

      // Cache keyed on (phone, address, resolved params).
      expect(comps.checkCache).toHaveBeenCalledWith("+15559990000", TARGET, DEFAULT_COMP_PARAMS);
      expect(result.reserved).toBe(true);
      expect(result.charged).toBe(0);
      expect(compsEngine.buildComps).not.toHaveBeenCalled();
      expect(credits.chargeForComps).not.toHaveBeenCalled();
      // Free copy re-served verbatim with an "on record, free" note — NO OK prompt.
      expect(sent().toLowerCase()).toContain("already on record");
      expect(sent().toLowerCase()).not.toContain("reply ok");
      expect(sent().endsWith("Every Lead Deserves Jake.\nGoTextJake.com/CRM")).toBe(true);
      // No pending offer is ever parked now.
      expect(comps.setPending).not.toHaveBeenCalled();
    });

    it("no address to run → guidance, no charge, no run", async () => {
      orchestrator.plan.mockResolvedValue(compsPlan({ targetEntity: null }));
      memory.lastResolvedAddress.mockResolvedValue(null);

      const result = await service.handleInboundMessage({
        contactId: "ct_1",
        senderPhone: "+15559990000",
        message: "pull comps",
      });

      expect(result.charged).toBe(0);
      expect(compsEngine.buildComps).not.toHaveBeenCalled();
      expect(comps.setPending).not.toHaveBeenCalled();
      expect(comps.checkCache).not.toHaveBeenCalled();
    });

    it("JAK-159: 'comp the last one' runs on the MOST-RECENT address, not the stale ordinal-list end", async () => {
      // A "last" reference: targetEntity null, addressRecency="last", and a STALE ordinal
      // that would otherwise point at the oldest address. The comps must run on the
      // genuinely most-recent address (lastResolvedAddress).
      orchestrator.plan.mockResolvedValue(
        compsPlan({ targetEntity: null, addressOrdinal: 1, addressRecency: "last" })
      );
      memory.resolvedAddressList.mockResolvedValue(["1 Old St, Town, CA 90000", "2 Mid Ave, Town, CA 90000"]);
      memory.lastResolvedAddress.mockResolvedValue("3 Newest Blvd, Town, CA 90000");
      realEstate.getCompsByAddress.mockResolvedValue(compsHit as never);

      await service.handleInboundMessage({
        contactId: "ct_1",
        senderPhone: "+15559990000",
        message: "comp the last one",
      });

      expect(compsEngine.buildComps).toHaveBeenCalledWith({ target: "3 Newest Blvd, Town, CA 90000", params: DEFAULT_COMP_PARAMS });
      expect(compsEngine.buildComps).not.toHaveBeenCalledWith(expect.objectContaining({ target: "1 Old St, Town, CA 90000" }));
    });
  });

  // ── JAK-138: conversational UX polish ──────────────────────────────────────
  describe("JAK-138 disambiguation (ask instead of guess)", () => {
    const A1 = "123 Main St, Springfield, IL 62704";
    const A2 = "742 Evergreen Terrace, Springfield, IL 62704";
    const sent = () => (gateway.sendSms.mock.calls.at(-1)![0] as { message: string }).message;

    it("ambiguous bare property_report (2+ addresses, no clear pick) → numbered list + ask, NO spend, parks the question", async () => {
      // JAK-154 narrowed the bare-ambiguity ask to PROPERTY REPORTS — a bare skip-trace
      // / comps now defaults to the most recent address (see the JAK-154 block below).
      memory.resolvedAddressList.mockResolvedValue([A1, A2]);
      orchestrator.plan.mockResolvedValue({
        intent: "property_report",
        targetEntity: null,
        specialists: reportSpecialist(),
        userFacingNote: "",
      });

      const result = await service.handleInboundMessage({
        contactId: "ct_1",
        senderPhone: "+15559990000",
        message: "pull the report",
      });

      expect(result.charged).toBe(0);
      // No paid API, no report run — we asked which address first.
      expect(realEstate.searchPropertyByAddress).not.toHaveBeenCalled();
      // The pending QUESTION remembers the waiting intent for the number follow-up.
      expect(disambiguation.setPending).toHaveBeenCalledWith({
        phone: "+15559990000",
        customerId: "cust_+15559990000",
        intent: "property_report",
        compParams: null,
      });
      expect(sent()).toContain(`1. ${A1}`);
      expect(sent()).toContain(`2. ${A2}`);
      expect(sent().toLowerCase()).toContain("which one");
      expect(sent().endsWith("Every Lead Deserves Jake.\nGoTextJake.com/CRM")).toBe(true);
      expect(sent()).not.toMatch(/\p{Extended_Pictographic}/u);
    });

    it("out-of-range ordinal → says how many exist and lists them", async () => {
      memory.resolvedAddressList.mockResolvedValue([A1, A2]);
      orchestrator.plan.mockResolvedValue({
        intent: "property_report",
        targetEntity: null,
        specialists: reportSpecialist(),
        userFacingNote: "",
        addressOrdinal: 5,
      });

      const result = await service.handleInboundMessage({
        contactId: "ct_1",
        senderPhone: "+15559990000",
        message: "the 5th address",
      });

      expect(result.charged).toBe(0);
      expect(realEstate.searchPropertyByAddress).not.toHaveBeenCalled();
      expect(sent()).toContain("2 addresses");
      expect(sent()).toContain("not 5");
      expect(sent()).toContain(`1. ${A1}`);
      expect(disambiguation.setPending).toHaveBeenCalledWith(
        expect.objectContaining({ intent: "property_report" })
      );
    });

    it("a bare NUMBER after the ask RUNS the stored intent immediately on the picked address", async () => {
      memory.resolvedAddressList.mockResolvedValue([A1, A2]);
      disambiguation.freshPending.mockResolvedValue(disambigRow({ intent: "comps", comp_params: null }));

      await service.handleInboundMessage({
        contactId: "ct_1",
        senderPhone: "+15559990000",
        message: "2",
      });

      // Address 2 selected → the question is consumed and comps RUNS on A2 (JAK-144:
      // no confirmation, no pending offer).
      expect(disambiguation.clearPending).toHaveBeenCalledWith("+15559990000");
      expect(compsEngine.buildComps).toHaveBeenCalledWith({ target: A2, params: DEFAULT_COMP_PARAMS });
      expect(comps.setPending).not.toHaveBeenCalled();
    });

    it("'the last one' selects the final address for the stored intent and runs it", async () => {
      memory.resolvedAddressList.mockResolvedValue([A1, A2]);
      disambiguation.freshPending.mockResolvedValue(disambigRow({ intent: "skip_trace", comp_params: null }));
      realEstate.skipTraceByAddress.mockResolvedValue({
        match: true,
        persons: [{ fullName: "Homer Simpson", phones: [{ phone: "+15550101" }] }],
      } as never);

      await service.handleInboundMessage({
        contactId: "ct_1",
        senderPhone: "+15559990000",
        message: "the last one",
      });

      expect(realEstate.skipTraceByAddress).toHaveBeenCalledWith(A2);
      expect(skipTrace.setPending).not.toHaveBeenCalled();
    });

    it("a still-out-of-range pick re-asks and keeps the question", async () => {
      memory.resolvedAddressList.mockResolvedValue([A1, A2]);
      disambiguation.freshPending.mockResolvedValue(disambigRow({ intent: "comps", comp_params: null }));

      const result = await service.handleInboundMessage({
        contactId: "ct_1",
        senderPhone: "+15559990000",
        message: "7",
      });

      expect(result.charged).toBe(0);
      expect(comps.setPending).not.toHaveBeenCalled();
      // Re-asks (parks the question again) rather than running anything.
      expect(disambiguation.setPending).toHaveBeenCalledWith(expect.objectContaining({ intent: "comps" }));
      expect(sent()).toContain("not 7");
    });

    it("ambiguous PERSON reference lists the people from the last trace and asks", async () => {
      skipTrace.latestTraceForPhone.mockResolvedValue(
        skipTraceRow({
          normalized_target: A2,
          trace_record: {
            output: { identity: { names: [{ fullName: "Homer Simpson" }, { fullName: "Marge Simpson" }] } },
          },
        })
      );
      orchestrator.plan.mockResolvedValue({
        intent: "skip_trace",
        targetEntity: null,
        specialists: skipTraceSpecialist(),
        userFacingNote: "",
      });

      const result = await service.handleInboundMessage({
        contactId: "ct_1",
        senderPhone: "+15559990000",
        message: "skip trace that owner",
      });

      expect(result.charged).toBe(0);
      expect(realEstate.skipTraceByAddress).not.toHaveBeenCalled();
      expect(skipTrace.setPending).not.toHaveBeenCalled();
      expect(sent()).toContain("Homer Simpson");
      expect(sent()).toContain("Marge Simpson");
      expect(sent().toLowerCase()).toContain("who did you mean");
    });

    it("PERSON reference that resolves to one person re-serves that trace for FREE", async () => {
      skipTrace.latestTraceForPhone.mockResolvedValue(
        skipTraceRow({ normalized_target: A2, trace_record: { name: "Homer Simpson" } })
      );
      orchestrator.plan.mockResolvedValue({
        intent: "skip_trace",
        targetEntity: null,
        specialists: skipTraceSpecialist(),
        userFacingNote: "",
      });

      const result = await service.handleInboundMessage({
        contactId: "ct_1",
        senderPhone: "+15559990000",
        message: "skip trace that owner",
      });

      expect(result.reserved).toBe(true);
      expect(result.charged).toBe(0);
      expect(realEstate.skipTraceByAddress).not.toHaveBeenCalled();
      expect(sent()).toContain("Homer Simpson");
      // JAK-144: free re-serve, no pending offer, no OK prompt.
      expect(skipTrace.setPending).not.toHaveBeenCalled();
      expect(sent().toLowerCase()).not.toContain("reply ok");
    });
  });

  // JAK-154 — a BARE skip-trace / comps (no explicit address, no ordinal, no named
  // person) must default to the MOST RECENT address the texter engaged with — the
  // last property they got a report on — NOT the first-in-list and NOT an older
  // one it already handled. This fixes the live report: "it's not skipping the last
  // address, it's like going back and doing one it already did."
  describe("JAK-154 bare skip-trace / comps default to the MOST RECENT address", () => {
    const A = "111 First Ave, Springfield, IL 62701";
    const B = "222 Second St, Springfield, IL 62702";
    const C = "333 Third Blvd, Springfield, IL 62703";

    // A contact match at the top-level persons[] shape (fictional persona, no live call).
    const personsHit = {
      match: true,
      persons: [
        { fullName: "Homer Simpson", phones: [{ phone: "+15550101" }], emails: ["homer@example.com"] },
      ],
    };
    // A bare skip-trace plan: the router named no address, ordinal, or person.
    const bareSkipTrace: DispatchPlan = {
      intent: "skip_trace",
      targetEntity: null,
      specialists: skipTraceSpecialist(),
      userFacingNote: "",
    };
    const bareComps: DispatchPlan = {
      intent: "comps",
      targetEntity: null,
      specialists: compsSpecialist(),
      userFacingNote: "",
      compParams: null,
    };

    it("after A, B, C reports, a bare 'skip trace' targets the MOST RECENT (C) — never an older one", async () => {
      // Every address is on file, oldest-first, and C is the last one they engaged with.
      memory.resolvedAddressList.mockResolvedValue([A, B, C]);
      memory.lastResolvedAddress.mockResolvedValue(C);
      orchestrator.plan.mockResolvedValue(bareSkipTrace);
      realEstate.skipTraceByAddress.mockResolvedValue(personsHit as never);

      const result = await service.handleInboundMessage({
        contactId: "ct_1",
        senderPhone: "+15559990000",
        message: "skip trace",
      });

      // Traced C — the newest — and NEVER re-ran the older A or B.
      expect(realEstate.skipTraceByAddress).toHaveBeenCalledWith(C);
      expect(realEstate.skipTraceByAddress).not.toHaveBeenCalledWith(A);
      expect(realEstate.skipTraceByAddress).not.toHaveBeenCalledWith(B);
      expect(skipTrace.checkCache).toHaveBeenCalledWith("+15559990000", C, "");
      // Did NOT stop to ask which address — a bare trace is no longer ambiguous.
      expect(disambiguation.setPending).not.toHaveBeenCalled();
      expect(result.charged).toBe(3);
    });

    it("reporting a NEW address then a bare 'skip trace' targets the NEW one (recency wins)", async () => {
      orchestrator.plan.mockResolvedValue(bareSkipTrace);
      realEstate.skipTraceByAddress.mockResolvedValue(personsHit as never);

      // First the newest report on file is A → a bare trace hits A.
      memory.resolvedAddressList.mockResolvedValue([A]);
      memory.lastResolvedAddress.mockResolvedValue(A);
      await service.handleInboundMessage({ contactId: "ct_1", senderPhone: "+15559990000", message: "skip trace" });
      expect(realEstate.skipTraceByAddress).toHaveBeenLastCalledWith(A);

      // Then they report B; now the newest is B → the following bare trace hits B, not A.
      memory.resolvedAddressList.mockResolvedValue([A, B]);
      memory.lastResolvedAddress.mockResolvedValue(B);
      await service.handleInboundMessage({ contactId: "ct_1", senderPhone: "+15559990000", message: "skip trace" });
      expect(realEstate.skipTraceByAddress).toHaveBeenLastCalledWith(B);
    });

    it("a bare 'run comps' targets the MOST RECENT address, same as skip-trace", async () => {
      memory.resolvedAddressList.mockResolvedValue([A, B, C]);
      memory.lastResolvedAddress.mockResolvedValue(C);
      orchestrator.plan.mockResolvedValue(bareComps);

      const result = await service.handleInboundMessage({
        contactId: "ct_1",
        senderPhone: "+15559990000",
        message: "run comps",
      });

      expect(compsEngine.buildComps).toHaveBeenCalledWith({ target: C, params: DEFAULT_COMP_PARAMS });
      expect(compsEngine.buildComps).not.toHaveBeenCalledWith(expect.objectContaining({ target: A }));
      expect(disambiguation.setPending).not.toHaveBeenCalled();
      expect(result.charged).toBe(3);
    });

    it("an EXPLICIT reference still wins over most-recent — 'the first one' traces A, not C", async () => {
      // The router resolves an in-range ordinal to a concrete targetEntity upstream;
      // the bare-default never overrides an explicitly named address.
      memory.resolvedAddressList.mockResolvedValue([A, B, C]);
      memory.lastResolvedAddress.mockResolvedValue(C);
      orchestrator.plan.mockResolvedValue({ ...bareSkipTrace, targetEntity: A, addressOrdinal: 1 });
      realEstate.skipTraceByAddress.mockResolvedValue(personsHit as never);

      await service.handleInboundMessage({
        contactId: "ct_1",
        senderPhone: "+15559990000",
        message: "skip trace the first one",
      });

      expect(realEstate.skipTraceByAddress).toHaveBeenCalledWith(A);
      expect(realEstate.skipTraceByAddress).not.toHaveBeenCalledWith(C);
    });

    it("a NAMED person on a bare trace uses that person AT the most-recent address", async () => {
      memory.resolvedAddressList.mockResolvedValue([A, B, C]);
      memory.lastResolvedAddress.mockResolvedValue(C);
      orchestrator.plan.mockResolvedValue({ ...bareSkipTrace, personNames: ["Georgina Rey"] });
      realEstate.skipTraceByAddress.mockResolvedValue(personsHit as never);

      await service.handleInboundMessage({
        contactId: "ct_1",
        senderPhone: "+15559990000",
        message: "skip trace Georgina Rey",
      });

      // Traced the NAMED person against the newest address (C), keyed per-person (JAK-145).
      expect(realEstate.skipTraceByAddress).toHaveBeenCalledWith(C, {
        firstName: "Georgina",
        lastName: "Rey",
      });
      expect(skipTrace.checkCache).toHaveBeenCalledWith("+15559990000", C, "georgina rey");
    });
  });

  // JAK-165 — the Eric bug: a texter with a long/messy history sends a BARE "comps"
  // or "skip" (no inline address, no ordinal, no "last"). The router LLM still fills
  // targetAddress with a GUESS from history, and on a cluttered history it sometimes
  // guesses an OLD address. Before the fix that guess became plan.targetEntity and
  // short-circuited the JAK-154 most-recent fallback, so the wrong (older) property was
  // comped/traced. This drives the REAL JakeOrchestrator (only the router LLM is mocked)
  // end-to-end to prove a bare skip/comps now ALWAYS lands on the most-recent address,
  // never the router's stale guess.
  describe("JAK-165 bare skip/comps ignores the router's OLD history guess → most-recent", () => {
    const A = "111 First Ave, Springfield, IL 62701"; // OLD — the router's stale guess
    const B = "222 Second St, Springfield, IL 62702";
    const C = "333 Third Blvd, Springfield, IL 62703"; // NEWEST — what a bare command must hit

    const personsHit = {
      match: true,
      persons: [
        { fullName: "Homer Simpson", phones: [{ phone: "+15550101" }], emails: ["homer@example.com"] },
      ],
    };

    let routerLlm: MockProxy<RouterLlmClient>;

    beforeEach(() => {
      // Route the assistant through the PRODUCTION orchestrator so the resolveTarget fix
      // is genuinely exercised — only the router LLM seam is mocked (no network).
      const prompts = mock<OrchestratorPromptService>();
      prompts.getEffectivePrompt.mockResolvedValue("STYLE PROMPT");
      routerLlm = mock<RouterLlmClient>();
      const realOrchestrator = new JakeOrchestrator(prompts, memory, new SpecialistRegistry(), routerLlm);
      orchestrator.plan.mockImplementation((input) => realOrchestrator.plan(input));

      // A long/messy history: A, B, C on file (oldest-first), and C is the newest one
      // the texter engaged with.
      memory.recentMessages.mockResolvedValue([]);
      memory.resolvedAddressList.mockResolvedValue([A, B, C]);
      memory.lastResolvedAddress.mockResolvedValue(C);
    });

    it("bare 'comps' → comps the NEWEST (C), NOT the router's OLD targetAddress (A)", async () => {
      routerLlm.classify.mockResolvedValue({
        intent: "comps",
        targetAddress: A, // the stale history guess that used to win
        addressOrdinal: null,
        userFacingNote: "",
      });

      const result = await service.handleInboundMessage({
        contactId: "ct_1",
        senderPhone: "+15559990000",
        message: "comps",
      });

      expect(compsEngine.buildComps).toHaveBeenCalledWith({ target: C, params: DEFAULT_COMP_PARAMS });
      expect(compsEngine.buildComps).not.toHaveBeenCalledWith(expect.objectContaining({ target: A }));
      expect(disambiguation.setPending).not.toHaveBeenCalled();
      expect(result.charged).toBe(3);
    });

    it("bare 'skip' → traces the NEWEST (C), NOT the router's OLD targetAddress (A)", async () => {
      routerLlm.classify.mockResolvedValue({
        intent: "skip_trace",
        targetAddress: A, // the stale history guess that used to win
        addressOrdinal: null,
        userFacingNote: "",
      });
      realEstate.skipTraceByAddress.mockResolvedValue(personsHit as never);

      const result = await service.handleInboundMessage({
        contactId: "ct_1",
        senderPhone: "+15559990000",
        message: "skip",
      });

      expect(realEstate.skipTraceByAddress).toHaveBeenCalledWith(C);
      expect(realEstate.skipTraceByAddress).not.toHaveBeenCalledWith(A);
      expect(disambiguation.setPending).not.toHaveBeenCalled();
      expect(result.charged).toBe(3);
    });
  });

  // JAK-166 — the "Sunset Strip" bug: a texter looks up a NEW address wrapped in
  // conversational preamble ("Hey Jake, look up this address 7680 ..."). The
  // deterministic insert-time parser (parseCommandAddress) can't read that — it isn't
  // house-number-first — so the inbound row stores NO address, yet the report SUCCEEDS
  // on the LLM-resolved target. Before the fix that success never updated the active
  // property, so the next bare "comps" and "skip" fell back to a STALE older address
  // (and even diverged to DIFFERENT ones as the router re-guessed per command). The fix
  // backfills the acted-on address onto the requesting message, making it the single
  // source of truth. This drives the memory seam STATEFULLY (markResolvedAddress writes,
  // lastResolvedAddress reads — the same DB round-trip production performs) so the
  // write-back is genuinely exercised: looking up B must make a following bare COMP and
  // bare SKIP BOTH target B, never the older A.
  describe("JAK-166 a successful lookup becomes the single active property for later comps/skip", () => {
    const A = "5895 NW 62nd Ter, Parkland, FL 33067"; // OLD — the last address that parsed cleanly
    const B = "7680 Sunset Strip, Sunrise, FL 33322"; // NEW — looked up via conversational preamble

    const personsHit = {
      match: true,
      persons: [
        { fullName: "Homer Simpson", phones: [{ phone: "+15550101" }], emails: ["homer@example.com"] },
      ],
    };

    // The conversation's active-property memory, stateful: markResolvedAddress (the
    // fix's write-back) updates it, lastResolvedAddress reads it — exactly the DB
    // round-trip the production store performs.
    let active: string | null;

    const bareComps: DispatchPlan = {
      intent: "comps",
      targetEntity: null,
      specialists: compsSpecialist(),
      userFacingNote: "",
      compParams: null,
    };
    const bareSkip: DispatchPlan = {
      intent: "skip_trace",
      targetEntity: null,
      specialists: skipTraceSpecialist(),
      userFacingNote: "",
    };

    beforeEach(() => {
      active = null;
      memory.lastResolvedAddress.mockImplementation(async () => active);
      memory.markResolvedAddress.mockImplementation(async (_id: string, addr: string) => {
        active = addr;
      });
      memory.resolvedAddressList.mockResolvedValue([A, B]);
    });

    // Look up A the ordinary, parseable way — the default orchestrator turns a parsed
    // address into a property_report, and the fix records A as the active property.
    const reportA = async (): Promise<void> => {
      realEstate.searchPropertyByAddress.mockResolvedValue({ address: A } as never);
      await service.handleInboundMessage({ contactId: "ct_1", senderPhone: "+15559990000", message: A });
    };

    // Look up B through a preamble message the insert-time regex CAN'T parse, so the
    // router (LLM) resolves B into plan.targetEntity while appendInbound stores
    // resolvedAddress = null — the exact shape that produced the bug.
    const reportB = async (): Promise<void> => {
      orchestrator.plan.mockResolvedValue({
        intent: "property_report",
        targetEntity: B,
        specialists: reportSpecialist(),
        userFacingNote: "",
      });
      realEstate.searchPropertyByAddress.mockResolvedValue({ address: B } as never);
      await service.handleInboundMessage({
        contactId: "ct_1",
        senderPhone: "+15559990000",
        message: `Hey Jake, look up this address ${B}`,
      });
    };

    it("a report resolved via the LLM (unparseable inbound) still backfills the active property", async () => {
      await reportB();
      // The report acted on B and wrote it back onto the requesting inbound (msg_1),
      // even though parseCommandAddress returned null for the preamble message.
      expect(memory.markResolvedAddress).toHaveBeenCalledWith("msg_1", B);
      expect(active).toBe(B);
    });

    it("after lookup A then lookup B, a bare COMP and a bare SKIP BOTH target B — never A", async () => {
      await reportA();
      expect(active).toBe(A); // A is the active property so far

      await reportB();
      expect(active).toBe(B); // the newer lookup takes over as the single source of truth

      // Bare COMP → the most-recent engaged property (B), not the stale A.
      orchestrator.plan.mockResolvedValue(bareComps);
      await service.handleInboundMessage({ contactId: "ct_1", senderPhone: "+15559990000", message: "comps" });
      expect(compsEngine.buildComps).toHaveBeenCalledWith({ target: B, params: DEFAULT_COMP_PARAMS });
      expect(compsEngine.buildComps).not.toHaveBeenCalledWith(expect.objectContaining({ target: A }));

      // Bare SKIP → the SAME property B (one source of truth), never a DIFFERENT stale
      // address the way the reported bug diverged comps and skip to two old Parkland ones.
      orchestrator.plan.mockResolvedValue(bareSkip);
      realEstate.skipTraceByAddress.mockResolvedValue(personsHit as never);
      await service.handleInboundMessage({ contactId: "ct_1", senderPhone: "+15559990000", message: "skip" });
      expect(realEstate.skipTraceByAddress).toHaveBeenCalledWith(B);
      expect(realEstate.skipTraceByAddress).not.toHaveBeenCalledWith(A);
    });
  });

  // JAK-156 — an address typed INSIDE a skip/comps command ("skip 123 Main St, Tampa
  // FL", "comps 123 ...") must target THAT exact address, not an older one resolved
  // from conversation history. Before the fix the leading "skip" made the deterministic
  // parser skip the message, the address was discarded, and the router picked a stale
  // historical address (and JAK-154's most-recent fallback missed it too).
  describe("JAK-156 explicit address typed inside a skip / comps command", () => {
    const A = "111 First Ave, Springfield, IL 62701";
    const B = "222 Second St, Springfield, IL 62702";
    const C = "333 Third Blvd, Springfield, IL 62703";
    const EXPLICIT = "123 Main St, Tampa, FL 33601";

    const personsHit = {
      match: true,
      persons: [
        { fullName: "Homer Simpson", phones: [{ phone: "+15550101" }], emails: ["homer@example.com"] },
      ],
    };

    // Mirror the JAK-156 orchestrator wiring: a real inline parsedAddress OUTRANKS the
    // router's history-derived target, so plan.targetEntity is the typed address. (The
    // precedence itself is pinned in JakeOrchestrator.test.ts; here we prove the
    // assistant parses the inline address, remembers it, and acts on it end-to-end.)
    const planFromParsed = (intent: "skip_trace" | "comps"): void => {
      orchestrator.plan.mockImplementation(async ({ parsedAddress }): Promise<DispatchPlan> => ({
        intent,
        targetEntity: parsedAddress,
        specialists: intent === "skip_trace" ? skipTraceSpecialist() : compsSpecialist(),
        userFacingNote: "",
        compParams: null,
      }));
    };

    beforeEach(() => {
      // History is full of OLDER addresses; the newest engaged-with one is C. A correct
      // fix must ignore ALL of them in favor of the freshly-typed EXPLICIT address.
      memory.resolvedAddressList.mockResolvedValue([A, B, C]);
      memory.lastResolvedAddress.mockResolvedValue(C);
    });

    it("'skip 123 ...' traces the TYPED address, not a historical one", async () => {
      planFromParsed("skip_trace");
      realEstate.searchPropertyByAddress.mockResolvedValue({
        owner1FirstName: "Homer",
        owner1LastName: "Simpson",
      } as never);
      realEstate.skipTraceByAddress.mockResolvedValue(personsHit as never);

      const result = await service.handleInboundMessage({
        contactId: "ct_1",
        senderPhone: "+15559990000",
        message: `skip ${EXPLICIT}`,
      });

      // The assistant parsed the inline address and fed it to the router as parsedAddress.
      expect(orchestrator.plan).toHaveBeenCalledWith(
        expect.objectContaining({ message: `skip ${EXPLICIT}`, parsedAddress: EXPLICIT })
      );
      // Traced the TYPED address — never the historical A / B / C.
      expect(realEstate.skipTraceByAddress).toHaveBeenCalledWith(EXPLICIT, {
        firstName: "Homer",
        lastName: "Simpson",
      });
      expect(realEstate.skipTraceByAddress).not.toHaveBeenCalledWith(C, expect.anything());
      expect(realEstate.skipTraceByAddress).not.toHaveBeenCalledWith(A, expect.anything());
      // A "skip {new address}" is a NEW lookup, keyed on the new address — not a stale
      // re-serve of a cached older trace.
      expect(skipTrace.checkCache).toHaveBeenCalledWith("+15559990000", EXPLICIT, "homer simpson");
      expect(result.charged).toBe(3);
    });

    it("records the TYPED address to memory so it becomes the most-recent + ordinal entry", async () => {
      planFromParsed("skip_trace");
      realEstate.searchPropertyByAddress.mockResolvedValue({ owner1FirstName: "Homer" } as never);
      realEstate.skipTraceByAddress.mockResolvedValue(personsHit as never);

      await service.handleInboundMessage({
        contactId: "ct_1",
        senderPhone: "+15559990000",
        message: `skip ${EXPLICIT}`,
      });

      // Persisted the inbound WITH the resolved address — the store surfaces this as
      // lastResolvedAddress / the ordinal list, so a following bare "skip" hits EXPLICIT.
      expect(memory.appendInbound).toHaveBeenCalledWith(
        expect.objectContaining({ body: `skip ${EXPLICIT}`, resolvedAddress: EXPLICIT })
      );
    });

    it("'comps 123 ...' pulls comps for the TYPED address, not a historical one", async () => {
      planFromParsed("comps");

      const result = await service.handleInboundMessage({
        contactId: "ct_1",
        senderPhone: "+15559990000",
        message: `comps ${EXPLICIT}`,
      });

      expect(orchestrator.plan).toHaveBeenCalledWith(
        expect.objectContaining({ parsedAddress: EXPLICIT })
      );
      expect(compsEngine.buildComps).toHaveBeenCalledWith({ target: EXPLICIT, params: DEFAULT_COMP_PARAMS });
      expect(compsEngine.buildComps).not.toHaveBeenCalledWith(expect.objectContaining({ target: C }));
      expect(memory.appendInbound).toHaveBeenCalledWith(
        expect.objectContaining({ resolvedAddress: EXPLICIT })
      );
      expect(result.charged).toBe(3);
    });

    it("a BARE 'skip trace' (no typed address) still targets the most-recent C (JAK-154 intact)", async () => {
      // No inline address → parsedAddress is null → the router's bare plan + the
      // JAK-154 most-recent fallback still apply.
      orchestrator.plan.mockResolvedValue({
        intent: "skip_trace",
        targetEntity: null,
        specialists: skipTraceSpecialist(),
        userFacingNote: "",
      });
      realEstate.skipTraceByAddress.mockResolvedValue(personsHit as never);

      await service.handleInboundMessage({
        contactId: "ct_1",
        senderPhone: "+15559990000",
        message: "skip trace",
      });

      expect(orchestrator.plan).toHaveBeenCalledWith(
        expect.objectContaining({ parsedAddress: null })
      );
      expect(realEstate.skipTraceByAddress).toHaveBeenCalledWith(C);
      expect(realEstate.skipTraceByAddress).not.toHaveBeenCalledWith(EXPLICIT, expect.anything());
    });
  });

  describe("JAK-144 no confirm-before-spend (clean cancel)", () => {
    it("a bare 'Y' no longer triggers a paid specialist run (no pending to confirm)", async () => {
      // JAK-144 removed the skip-trace/comps confirmation, so there is no pending
      // offer for a bare affirmative to confirm. The router treats a bare "Y" as a
      // report_refresh; with no prior address it falls to guidance — never a paid
      // skip-trace/comps run.
      memory.lastResolvedAddress.mockResolvedValue(null);

      const result = await service.handleInboundMessage({
        contactId: "ct_1",
        senderPhone: "+15559990000",
        message: "Y",
      });

      expect(realEstate.skipTraceByAddress).not.toHaveBeenCalled();
      expect(compsEngine.buildComps).not.toHaveBeenCalled();
      expect(result.charged).toBe(0);
    });

    it("a non-affirmative reply CANCELS any pending question cleanly — no charge, nothing stuck", async () => {
      orchestrator.plan.mockResolvedValue({
        intent: "chitchat",
        targetEntity: null,
        specialists: [],
        userFacingNote: "",
      });

      const result = await service.handleInboundMessage({
        contactId: "ct_1",
        senderPhone: "+15559990000",
        message: "actually never mind",
      });

      expect(result.charged).toBe(0);
      expect(disambiguation.clearPending).toHaveBeenCalledWith("+15559990000");
      expect(realEstate.skipTraceByAddress).not.toHaveBeenCalled();
      expect(compsEngine.buildComps).not.toHaveBeenCalled();
    });
  });

  describe("JAK-138 help / capability menu", () => {
    const sent = () => (gateway.sendSms.mock.calls.at(-1)![0] as { message: string }).message;

    it("lists the capabilities WITHOUT any credit costs (JAK-silent-credits-intro)", async () => {
      orchestrator.plan.mockResolvedValue({
        intent: "chitchat",
        targetEntity: null,
        specialists: [],
        userFacingNote: "",
      });

      await service.handleInboundMessage({
        contactId: "ct_1",
        senderPhone: "+15559990000",
        message: "help",
      });

      // The capabilities are still listed...
      expect(sent()).toContain("Property report");
      expect(sent()).toContain("skip trace");
      expect(sent()).toContain("comps");
      // ...but NO credit costs are surfaced (credits never appear outside out-of-credits).
      expect(sent().toLowerCase()).not.toContain("credit");
      expect(sent()).not.toMatch(/\(\d+ credit/);
      expect(sent().endsWith("Every Lead Deserves Jake.\nGoTextJake.com/CRM")).toBe(true);
      expect(sent()).not.toMatch(/\p{Extended_Pictographic}/u);
    });
  });

  describe("JAK-138 latency ack", () => {
    it("a comps run sends a brief ack FIRST, then delivers the result", async () => {
      orchestrator.plan.mockResolvedValue({
        intent: "comps",
        targetEntity: "742 Evergreen Terrace, Springfield, IL 62704",
        specialists: compsSpecialist(),
        userFacingNote: "",
        compParams: null,
      });
      realEstate.getCompsByAddress.mockResolvedValue({
        comps: [{ address: "123 Nearby St", lastSaleAmount: 400000, bedrooms: 3, bathrooms: 2, squareFeet: 1500 }],
        subject: { bedrooms: 3, bathrooms: 2, squareFeet: 1500 },
      } as never);

      await service.handleInboundMessage({
        contactId: "ct_1",
        senderPhone: "+15559990000",
        message: "comps for 742 Evergreen Terrace",
      });

      const messages = gateway.sendSms.mock.calls.map((c) => (c[0] as { message: string }).message);
      expect(messages[0]).toBe("Working on it, one moment.");
      expect(messages.length).toBeGreaterThanOrEqual(2);
      expect(messages.at(-1)).toContain("Comparable sales");
    });
  });

  describe("JAK-first-text-welcome", () => {
    // Every message these paths send must stay emoji-free (the no-emoji rule).
    const EMOJI_RE =
      /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}️]/u;
    const sent = () => gateway.sendSms.mock.calls.map((c) => (c[0] as { message: string }).message);
    const firstContact = (over: Partial<TextJakeCustomer> = {}) =>
      customers.resolveByPhoneWithCreation.mockResolvedValue({
        customer: { ...customerFor("+15559990000"), ...over },
        created: true,
      });
    const returning = (over: Partial<TextJakeCustomer> = {}) =>
      customers.resolveByPhoneWithCreation.mockResolvedValue({
        customer: { ...customerFor("+15559990000"), ...over },
        created: false,
      });

    it("first-ever text is an ADDRESS: returns the report ONLY, credits granted silently, NO credit announcement", async () => {
      firstContact();
      realEstate.searchPropertyByAddress.mockResolvedValue({ address: "1 A St" } as never);

      const result = await service.handleInboundMessage({
        contactId: "ct_1",
        senderPhone: "+15559990000",
        message: "1 A St, Town, CA 90000",
      });

      const messages = sent();
      // The report is delivered + charged in the SAME interaction.
      expect(messages.some((m) => m.includes("Jake Property Report"))).toBe(true);
      expect(result.charged).toBe(1);
      // No welcome, no intro, and NOTHING that announces credits/balances (silent grant).
      expect(messages.some((m) => m.includes("Welcome to Jake"))).toBe(false);
      expect(messages.some((m) => m.includes("this is Jake. Text me any address"))).toBe(false);
      expect(messages.some((m) => m.toLowerCase().includes("credit"))).toBe(false);
    });

    it("first-ever text is a GREETING: sends the simple intro ONLY — no credits, no menu, no report", async () => {
      firstContact();

      const result = await service.handleInboundMessage({
        contactId: "ct_1",
        senderPhone: "+15559990000",
        message: "hey",
      });

      const messages = sent();
      // Exactly the intro (plus footer) — nothing else.
      expect(result.reply).toContain("Hey, this is Jake. Text me any address and I'll tell you everything I know about it.");
      expect(messages.length).toBe(1);
      // No credits mentioned, no capability menu, no lookup.
      expect(result.reply.toLowerCase()).not.toContain("credit");
      expect(result.reply).not.toContain("Here's what I can do");
      // JAK-onboarding-address-routing: the intro decision now ATTEMPTS address
      // resolution via the orchestrator first (so preamble addresses aren't misread
      // as greetings), so plan() IS consulted — but a true greeting resolves NO
      // address, so nothing is looked up.
      expect(realEstate.searchPropertyByAddress).not.toHaveBeenCalled();
      expect(result.charged).toBe(0);
      expect(EMOJI_RE.test(result.reply)).toBe(false);
    });

    it("returning customer does NOT get the intro again", async () => {
      returning();
      realEstate.searchPropertyByAddress.mockResolvedValue({ address: "1 A St" } as never);

      await service.handleInboundMessage({
        contactId: "ct_1",
        senderPhone: "+15559990000",
        message: "1 A St, Town, CA 90000",
      });

      expect(sent().some((m) => m.includes("Welcome to Jake"))).toBe(false);
      expect(sent().some((m) => m.includes("this is Jake. Text me any address"))).toBe(false);
    });

    // JAK-onboarding-address-routing: a first message that CONTAINS an address behind
    // PREAMBLE ("Hey Jake, look up this address 123 Main St") reads as null to the
    // strict inline parser, so the old code sent the greeting intro instead of the
    // report. The intro decision now attempts resolution via the SAME orchestrator/LLM
    // path the report flow uses, so a resolvable address runs the report — no intro.
    describe("first-contact address behind preamble runs the report, not the intro", () => {
      // The LLM router resolves the address out of the preamble (the strict inline
      // parser can't); mock plan() to mirror that so the assistant sees a real target.
      const resolveViaLlm = (targetEntity: string) =>
        orchestrator.plan.mockResolvedValue({
          intent: "property_report",
          targetEntity,
          specialists: reportSpecialist(),
          userFacingNote: "",
        } as DispatchPlan);

      it("EXACT repro: 'Hey Jake, look up this address 7704 Deer Run Rd Henryville Indiana' → REPORT, no intro", async () => {
        firstContact();
        resolveViaLlm("7704 Deer Run Rd, Henryville, IN");
        realEstate.searchPropertyByAddress.mockResolvedValue({ address: "7704 Deer Run Rd" } as never);

        const result = await service.handleInboundMessage({
          contactId: "ct_1",
          senderPhone: "+15559990000",
          message: "Hey Jake, look up this address 7704 Deer Run Rd Henryville Indiana",
        });

        const messages = sent();
        // The report is delivered + charged — NOT the greeting intro.
        expect(messages.some((m) => m.includes("Jake Property Report"))).toBe(true);
        expect(result.charged).toBe(1);
        expect(messages.some((m) => m.includes("this is Jake. Text me any address"))).toBe(false);
        // And credits stay silent (nothing announces a balance/grant on first contact).
        expect(messages.some((m) => m.toLowerCase().includes("credit"))).toBe(false);
      });

      it.each([
        ["hey can you look up 123 Main St", "123 Main St, Tampa, FL"],
        ["what about 456 Oak Ave", "456 Oak Ave, Austin, TX"],
      ])("preamble variant %p → report, not intro", async (message, resolved) => {
        firstContact();
        resolveViaLlm(resolved);
        realEstate.searchPropertyByAddress.mockResolvedValue({ address: resolved } as never);

        const result = await service.handleInboundMessage({
          contactId: "ct_1",
          senderPhone: "+15559990000",
          message,
        });

        const messages = sent();
        expect(messages.some((m) => m.includes("Jake Property Report"))).toBe(true);
        expect(messages.some((m) => m.includes("this is Jake. Text me any address"))).toBe(false);
        expect(result.charged).toBe(1);
      });

      it.each(["hey", "hi"])("plain greeting %p (NO address) still sends the intro ONLY", async (message) => {
        firstContact();
        // Default plan() mock returns chitchat with a null target for a non-address.

        const result = await service.handleInboundMessage({
          contactId: "ct_1",
          senderPhone: "+15559990000",
          message,
        });

        expect(result.reply).toContain("Hey, this is Jake. Text me any address and I'll tell you everything I know about it.");
        expect(sent().length).toBe(1);
        expect(realEstate.searchPropertyByAddress).not.toHaveBeenCalled();
        expect(result.charged).toBe(0);
      });
    });

    it("sends the onboarding email ask exactly ONCE, right after the 3rd report", async () => {
      returning(); // established customer, no profile yet
      realEstate.searchPropertyByAddress.mockResolvedValue({ address: "1 A St" } as never);
      customers.incrementReportCount.mockResolvedValue(3); // this delivery is their 3rd

      await service.handleInboundMessage({
        contactId: "ct_1",
        senderPhone: "+15559990000",
        message: "1 A St, Town, CA 90000",
      });

      // Guarded once via markOnboardingAsked; the ask uses the editable wording.
      expect(customers.markOnboardingAsked).toHaveBeenCalledWith("cust_+15559990000");
      const ask = sent().find((m) => m.includes("getting to know each other"));
      expect(ask).toBeDefined();
      expect(ask!.toLowerCase()).toContain("name and email");
      expect(EMOJI_RE.test(ask!)).toBe(false);
    });

    it("uses the ADMIN-EDITED wording for the ask when set", async () => {
      returning();
      realEstate.searchPropertyByAddress.mockResolvedValue({ address: "1 A St" } as never);
      customers.incrementReportCount.mockResolvedValue(3);
      onboardingPrompt.getEffectivePrompt.mockResolvedValue("Drop your name and email for the full report.");

      await service.handleInboundMessage({
        contactId: "ct_1",
        senderPhone: "+15559990000",
        message: "1 A St, Town, CA 90000",
      });

      expect(sent().some((m) => m.includes("Drop your name and email for the full report."))).toBe(true);
    });

    it("does NOT ask before the 3rd report", async () => {
      returning();
      realEstate.searchPropertyByAddress.mockResolvedValue({ address: "1 A St" } as never);
      customers.incrementReportCount.mockResolvedValue(2);

      await service.handleInboundMessage({
        contactId: "ct_1",
        senderPhone: "+15559990000",
        message: "1 A St, Town, CA 90000",
      });

      expect(customers.markOnboardingAsked).not.toHaveBeenCalled();
      expect(sent().some((m) => m.includes("getting to know each other"))).toBe(false);
    });

    it("does NOT ask a customer who already gave their name + email", async () => {
      returning({ firstName: "Sara", lastName: "Kim", email: "sara@example.com" });
      realEstate.searchPropertyByAddress.mockResolvedValue({ address: "1 A St" } as never);
      customers.incrementReportCount.mockResolvedValue(3);

      await service.handleInboundMessage({
        contactId: "ct_1",
        senderPhone: "+15559990000",
        message: "1 A St, Town, CA 90000",
      });

      expect(customers.markOnboardingAsked).not.toHaveBeenCalled();
      expect(sent().some((m) => m.includes("getting to know each other"))).toBe(false);
    });

    it("captures a follow-up name + email reply into the profile and acknowledges (after the ask)", async () => {
      // The ask has already been sent (onboardingAskedAt set), profile still empty.
      returning({ onboardingAskedAt: new Date("2026-07-07T00:00:00Z") });

      const result = await service.handleInboundMessage({
        contactId: "ct_1",
        senderPhone: "+15559990000",
        message: "Sara Kim, sara@example.com",
      });

      expect(customers.captureProfile).toHaveBeenCalledWith("cust_+15559990000", {
        firstName: "Sara",
        lastName: "Kim",
        email: "sara@example.com",
      });
      expect(result.reply).toContain("Sara");
      // A profile reply is not a lookup — no routing, no charge.
      expect(orchestrator.plan).not.toHaveBeenCalled();
      expect(result.charged).toBe(0);
    });

    it("does NOT hijack a name-like message when no ask is pending", async () => {
      returning(); // onboardingAskedAt null → capture stays off

      await service.handleInboundMessage({
        contactId: "ct_1",
        senderPhone: "+15559990000",
        message: "Sara Kim, sara@example.com",
      });

      expect(customers.captureProfile).not.toHaveBeenCalled();
      // Falls through to normal routing instead.
      expect(orchestrator.plan).toHaveBeenCalled();
    });
  });

  describe("JAK-credit-keyword (READ-ONLY balance status)", () => {
    const EMOJI_RE =
      /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}️]/u;
    const sent = () => gateway.sendSms.mock.calls.map((c) => (c[0] as { message: string }).message);
    // A returning customer with a known reset date and specific per-bucket balances.
    const withBalances = (
      balances: { report: number; skiptrace: number; comps: number },
      over: Partial<TextJakeCustomer> = {}
    ) => {
      customers.resolveByPhoneWithCreation.mockResolvedValue({
        customer: { ...customerFor("+15559990000"), ...over },
        created: false,
      });
      credits.getBalances.mockResolvedValue(balances);
    };

    it("'credit' reports all three balances + the reset date, with no charge and no routing", async () => {
      withBalances(
        { report: 50, skiptrace: 10, comps: 10 },
        { nextResetAt: new Date("2026-08-07T00:00:00Z") }
      );

      const result = await service.handleInboundMessage({
        contactId: "ct_1",
        senderPhone: "+15559990000",
        message: "credit",
      });

      // Read the RIGHT customer's bucket balances.
      expect(credits.getBalances).toHaveBeenCalledWith("acct_+15559990000");
      const reply = sent().at(-1)!;
      expect(reply).toContain("50 report credits");
      expect(reply).toContain("10 skip trace credits");
      expect(reply).toContain("10 comps credits");
      expect(reply).toContain("They reset on August 7.");
      expect(EMOJI_RE.test(reply)).toBe(false);
      // Status command — never orchestrated as a report/address.
      expect(orchestrator.plan).not.toHaveBeenCalled();
      // READ-ONLY: nothing charged or deducted from any bucket.
      expect(result.charged).toBe(0);
      expect(credits.chargeForTextLookup).not.toHaveBeenCalled();
      expect(credits.chargeForSkipTrace).not.toHaveBeenCalled();
      expect(credits.chargeForComps).not.toHaveBeenCalled();
      expect(credits.charge).not.toHaveBeenCalled();
      expect(realEstate.searchPropertyByAddress).not.toHaveBeenCalled();
      expect(result.intent).toBe("credit_balance");
    });

    it("also handles the plural 'Credits', case-insensitive and trimmed", async () => {
      withBalances(
        { report: 1, skiptrace: 0, comps: 3 },
        { nextResetAt: new Date("2026-09-01T00:00:00Z") }
      );

      await service.handleInboundMessage({
        contactId: "ct_1",
        senderPhone: "+15559990000",
        message: "  Credits!  ",
      });

      const reply = sent().at(-1)!;
      // Pluralization is per-bucket (1 credit vs 0/N credits).
      expect(reply).toContain("1 report credit,");
      expect(reply).toContain("0 skip trace credits");
      expect(reply).toContain("3 comps credits");
      expect(reply).toContain("They reset on September 1.");
      expect(orchestrator.plan).not.toHaveBeenCalled();
    });

    it("omits the reset sentence when next_reset_at is unknown (null)", async () => {
      withBalances({ report: 5, skiptrace: 3, comps: 4 }, { nextResetAt: null });

      await service.handleInboundMessage({
        contactId: "ct_1",
        senderPhone: "+15559990000",
        message: "credit",
      });

      const reply = sent().at(-1)!;
      expect(reply).toContain("You have 5 report credits, 3 skip trace credits, and 4 comps credits.");
      expect(reply).not.toContain("reset");
    });

    it("does NOT over-match: a real address still routes to a property report", async () => {
      // "123 Credit St" contains 'credit' but is not the bare keyword.
      realEstate.searchPropertyByAddress.mockResolvedValue({ address: "123 Credit St" } as never);

      const result = await service.handleInboundMessage({
        contactId: "ct_1",
        senderPhone: "+15559990000",
        message: "123 Credit St, Springfield, IL 62704",
      });

      // Routed + priced as a normal report — the keyword path never fired.
      expect(orchestrator.plan).toHaveBeenCalled();
      expect(credits.getBalances).not.toHaveBeenCalled();
      expect(result.charged).toBe(1);
      expect(sent().at(-1)!).toContain("Jake Property Report");
    });

    it("new customer's FIRST-EVER text is 'credit': keeps first contact clean — sends the intro, never a balance", async () => {
      customers.resolveByPhoneWithCreation.mockResolvedValue({
        customer: customerFor("+15559990000"),
        created: true,
      });

      const result = await service.handleInboundMessage({
        contactId: "ct_1",
        senderPhone: "+15559990000",
        message: "credit",
      });

      const messages = sent();
      // The clean intro is the answer — credits are seeded silently, never announced.
      expect(messages.some((m) => m.includes("Hey, this is Jake. Text me any address"))).toBe(true);
      expect(messages.some((m) => m.toLowerCase().includes("credit"))).toBe(false);
      // No balance message and no balance read on the very first message.
      expect(messages.some((m) => m.startsWith("You have"))).toBe(false);
      expect(credits.getBalances).not.toHaveBeenCalled();
      expect(orchestrator.plan).not.toHaveBeenCalled();
      expect(result.charged).toBe(0);
      expect(result.intent).toBe("credit_balance");
    });
  });
});
