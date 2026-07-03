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
import { ConversationMemoryService } from "../../ghlEnrichment/conversation/ConversationMemoryService";
import { LookupRow } from "../../ghlEnrichment/conversation/ConversationTypes";
import { PropertyReportWriter } from "../PropertyReportWriter";
import { PropertyReportData } from "../../types/PropertyReport";
import { JakeOrchestrator } from "../orchestrator/JakeOrchestrator";
import { DispatchPlan } from "../orchestrator/OrchestratorTypes";
import { SkipTraceReportWriter } from "../skiptrace/SkipTraceReportWriter";
import { SkipTraceMemoryService } from "../skiptrace/SkipTraceMemoryService";
import { SkipTraceSettingsService } from "../skiptrace/SkipTraceSettingsService";
import { SkipTracePendingRow, SkipTraceRow } from "../skiptrace/SkipTraceTypes";

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
  let reportWriter: MockProxy<PropertyReportWriter>;
  let memory: MockProxy<ConversationMemoryService>;
  let orchestrator: MockProxy<JakeOrchestrator>;
  let skipTraceWriter: MockProxy<SkipTraceReportWriter>;
  let skipTrace: MockProxy<SkipTraceMemoryService>;
  let skipTraceSettings: MockProxy<SkipTraceSettingsService>;
  let service: JakeAssistantService;

  const reportSpecialist = () => [{ name: "report", needsConfirmation: false, estimatedCredits: 1 }];
  const skipTraceSpecialist = () => [{ name: "skip_trace", needsConfirmation: true, estimatedCredits: 3 }];

  const skipTraceRow = (over: Partial<SkipTraceRow> = {}): SkipTraceRow => ({
    id: "st_1",
    customer_id: "cust_x",
    phone: "+15559990000",
    message_id: "msg_1",
    normalized_target: "742 Evergreen Terrace, Springfield, IL 62704",
    target_key: "742 evergreen terrace, springfield, il 62704",
    trace_record: { match: true },
    report_text:
      "Owner of 742 Evergreen Terrace: Homer Simpson\n\nPhone\n• +15550101\n\nGet more property info\nGoTextJake.com",
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
    report_text: "Jake Property Report\n123 Main St\n\nGet more property info\nGoTextJake.com",
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
    createdAt: new Date("2026-07-01T00:00:00Z"),
    updatedAt: new Date("2026-07-01T00:00:00Z"),
    ...over,
  });

  // A distinct credit account per phone, so billing-isolation assertions are real.
  const customerFor = (phone: string): TextJakeCustomer => ({
    id: `cust_${phone}`,
    phone,
    ghlContactId: null,
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
    reportWriter = mock<PropertyReportWriter>();
    memory = mock<ConversationMemoryService>();
    orchestrator = mock<JakeOrchestrator>();
    skipTraceWriter = mock<SkipTraceReportWriter>();
    skipTrace = mock<SkipTraceMemoryService>();
    skipTraceSettings = mock<SkipTraceSettingsService>();

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
      "Owner of 742 Evergreen Terrace: Homer Simpson\n\nPhone\n• +15550101\n\nGet more property info\nGoTextJake.com"
    );
    credits.hasCreditsForSkipTrace.mockResolvedValue(true);
    credits.chargeForSkipTrace.mockResolvedValue({ ok: true, balanceAfter: 7, entries: [] });
    credits.getBalance.mockResolvedValue(10);

    customers.resolveByPhone.mockImplementation(async (phone) => customerFor(phone));
    credits.hasCreditsForTextLookup.mockResolvedValue(true);
    credits.costOfTextLookup.mockReturnValue(1);
    credits.chargeForTextLookup.mockResolvedValue({ ok: true, balanceAfter: 9, entries: [] });
    gateway.sendSms.mockResolvedValue({ messageId: "gw_m1" });
    gateway.createContactNote.mockResolvedValue({ id: "n1", body: "note" });
    ghlClient.sendSms.mockResolvedValue({ messageId: "own_m1" });
    ghlClient.createNote.mockResolvedValue({ id: "n2", body: "note" });

    service = new JakeAssistantService(
      realEstate,
      ghlClient,
      gateway,
      connections,
      customers,
      credits,
      reportWriter,
      memory,
      orchestrator,
      skipTraceWriter,
      skipTrace,
      skipTraceSettings
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
      expect(gateway.createContactNote).toHaveBeenCalledWith("ct_1", expect.stringContaining("out of credits"));
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
      expect(sent).toMatch(/reply ok for a fresh copy \(costs 1 credit\)/i);
      expect(sent.endsWith("Get more property info\nGoTextJake.com")).toBe(true);
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

    it("comps intent → 'coming soon' reply, NO spend", async () => {
      orchestrator.plan.mockResolvedValue({
        intent: "comps",
        targetEntity: null,
        specialists: [{ name: "comps", needsConfirmation: true, estimatedCredits: 2 }],
        userFacingNote: "",
      });

      const result = await service.handleInboundMessage({
        contactId: "ct_1",
        senderPhone: "+15559990000",
        message: "what did nearby homes sell for?",
      });

      expect(result.intent).toBe("comps");
      expect(result.charged).toBe(0);
      expect(credits.chargeForTextLookup).not.toHaveBeenCalled();
      const sent = (gateway.sendSms.mock.calls[0]![0] as { message: string }).message;
      expect(sent.toLowerCase()).toContain("coming soon");
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
      expect(sent.endsWith("Get more property info\nGoTextJake.com")).toBe(true);
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
    const sent = () => (gateway.sendSms.mock.calls[0]![0] as { message: string }).message;

    it("first request QUOTES the cost + parks a pending offer — NO spend, NO paid API", async () => {
      orchestrator.plan.mockResolvedValue(skipTracePlan());

      const result = await service.handleInboundMessage({
        contactId: "ct_1",
        senderPhone: "+15559990000",
        message: "who owns 742 Evergreen Terrace?",
      });

      expect(result.charged).toBe(0);
      // Confirm-before-spend: no paid API call, no charge on the first ask.
      expect(realEstate.skipTraceByAddress).not.toHaveBeenCalled();
      expect(credits.chargeForSkipTrace).not.toHaveBeenCalled();
      expect(skipTrace.setPending).toHaveBeenCalledWith({
        phone: "+15559990000",
        customerId: "cust_+15559990000",
        target: TARGET,
        credits: 3,
      });
      expect(sent()).toContain("3 credits");
      expect(sent().toLowerCase()).toContain("reply ok");
      expect(sent().endsWith("Get more property info\nGoTextJake.com")).toBe(true);
      expect(sent()).not.toMatch(/\p{Extended_Pictographic}/u);
    });

    it("insufficient credits → clear no-charge message, NO pending offer, NO paid API", async () => {
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
      expect(sent()).toContain("3 credit");
      expect(sent().endsWith("Get more property info\nGoTextJake.com")).toBe(true);
    });

    it("bare OK after a quote RUNS the paid trace, charges EXACTLY the quoted cost, snapshots", async () => {
      // The router classifies a bare "OK" as report_refresh; the FRESH pending
      // skip-trace offer takes precedence, so the OK confirms the trace.
      skipTrace.freshPending.mockResolvedValue(pendingRow({ credits: 3 }));
      realEstate.skipTraceByAddress.mockResolvedValue({
        match: true,
        output: { identity: { name: "Homer Simpson", phones: [{ phone: "+15550101" }] } },
      } as never);

      const result = await service.handleInboundMessage({
        contactId: "ct_1",
        senderPhone: "+15559990000",
        message: "OK",
      });

      expect(realEstate.skipTraceByAddress).toHaveBeenCalledWith(TARGET);
      // Charged EXACTLY the quoted cost, to the texting customer's account.
      expect(credits.chargeForSkipTrace).toHaveBeenCalledWith({
        accountId: "acct_+15559990000",
        credits: 3,
      });
      expect(result.charged).toBe(3);
      // Offer consumed + result snapshotted for the free re-serve rule.
      expect(skipTrace.clearPending).toHaveBeenCalledWith("+15559990000");
      expect(skipTrace.recordTrace).toHaveBeenCalled();
      expect(sent()).toContain("Homer Simpson");
    });

    it("OK'd trace that finds NO contact info → no charge, offer consumed", async () => {
      skipTrace.freshPending.mockResolvedValue(pendingRow());
      realEstate.skipTraceByAddress.mockResolvedValue(null);

      const result = await service.handleInboundMessage({
        contactId: "ct_1",
        senderPhone: "+15559990000",
        message: "yes",
      });

      expect(realEstate.skipTraceByAddress).toHaveBeenCalledWith(TARGET);
      expect(credits.chargeForSkipTrace).not.toHaveBeenCalled();
      expect(result.charged).toBe(0);
      expect(skipTrace.recordTrace).not.toHaveBeenCalled();
      expect(sent().toLowerCase()).toContain("couldn't find");
      expect(sent().endsWith("Get more property info\nGoTextJake.com")).toBe(true);
    });

    it("repeat trace within the free window → FREE re-serve, NO paid API, NO charge", async () => {
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
      // Free copy re-served verbatim, plus a "reply OK for a fresh trace" notice.
      expect(sent()).toContain("Homer Simpson");
      expect(sent().toLowerCase()).toContain("reply ok for a fresh");
      expect(sent().endsWith("Get more property info\nGoTextJake.com")).toBe(true);
      // Parks a pending offer so a following OK runs a fresh (paid) trace.
      expect(skipTrace.setPending).toHaveBeenCalled();
    });

    it("no address to trace → guidance, no charge, no pending", async () => {
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

    it("no explicit target falls back to the last resolved address", async () => {
      orchestrator.plan.mockResolvedValue(skipTracePlan(null));
      memory.lastResolvedAddress.mockResolvedValue("9 B Rd, Town, CA 90000");

      await service.handleInboundMessage({
        contactId: "ct_1",
        senderPhone: "+15559990000",
        message: "skip trace it",
      });

      expect(skipTrace.checkCache).toHaveBeenCalledWith("+15559990000", "9 B Rd, Town, CA 90000");
      expect(skipTrace.setPending).toHaveBeenCalledWith(
        expect.objectContaining({ target: "9 B Rd, Town, CA 90000", credits: 3 })
      );
    });
  });
});
