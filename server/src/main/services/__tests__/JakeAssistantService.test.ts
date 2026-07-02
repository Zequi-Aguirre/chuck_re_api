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
import { PropertyReportWriter } from "../PropertyReportWriter";
import { PropertyReportData } from "../../types/PropertyReport";

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
  let service: JakeAssistantService;

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

    // The writer is exercised in its own suite; here it just echoes enough of the
    // assembled data back so the flow assertions (message contains the address)
    // hold, and so we can inspect the VERIFIED data the service handed it.
    reportWriter.write.mockImplementation(
      async (data: PropertyReportData) => `Jake Property Report\n${data.addressLine1 ?? "property"}`
    );

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
      reportWriter
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
      ]) {
        expect(data).not.toHaveProperty(key);
      }
      // Nothing anywhere is null/undefined.
      expect(Object.values(data).every((v) => v !== null && v !== undefined)).toBe(true);
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
    });
  });
});
