import { mock, MockProxy } from "jest-mock-extended";
import { JakeAssistantService } from "../JakeAssistantService";
import { RealEstateApiDao } from "../../data/RealEstateApiDao";
import { GhlApiClient } from "../../ghlEnrichment/api/GhlApiClient";

/**
 * JakeAssistantService is now multi-tenant (JAK-114): every reply is sent on the
 * `locationId` carried in the inbound message, through the JAK-104 client (which
 * loads THAT location's creds from the JAK-102 store). These tests pin that the
 * service never sends on anything but the location it was handed — the core
 * cross-tenant isolation guarantee at the service seam.
 */
describe("JakeAssistantService (multi-tenant text-Jake)", () => {
  let realEstate: MockProxy<RealEstateApiDao>;
  let ghlClient: MockProxy<GhlApiClient>;
  let service: JakeAssistantService;

  beforeEach(() => {
    realEstate = mock<RealEstateApiDao>();
    ghlClient = mock<GhlApiClient>();
    ghlClient.sendSms.mockResolvedValue({ messageId: "m_1" });
    service = new JakeAssistantService(realEstate, ghlClient);
  });

  it("sends the reply on the inbound message's location (per-tenant creds)", async () => {
    realEstate.searchPropertyByAddress.mockResolvedValue(null);

    await service.handleInboundMessage({
      locationId: "loc_a",
      contactId: "ct_1",
      message: "123 Main St, Springfield, IL 62704",
      fromNumber: "+15551230000",
    });

    expect(ghlClient.sendSms).toHaveBeenCalledTimes(1);
    expect(ghlClient.sendSms).toHaveBeenCalledWith("loc_a", {
      contactId: "ct_1",
      message: expect.any(String),
      fromNumber: "+15551230000",
    });
  });

  it("looks up the property then replies with a formatted summary", async () => {
    realEstate.searchPropertyByAddress.mockResolvedValue({
      address: "123 Main St, Springfield, IL 62704",
      bedrooms: 3,
      bathrooms: 2,
      estimatedValue: 350000,
    } as never);

    const result = await service.handleInboundMessage({
      locationId: "loc_a",
      contactId: "ct_1",
      message: "123 Main St, Springfield, IL 62704",
    });

    expect(realEstate.searchPropertyByAddress).toHaveBeenCalled();
    expect(result.ok).toBe(true);
    expect(result.reply).toContain("123 Main St");
    expect(result.reply).toContain("3 bd");
  });

  it("replies with guidance (no property lookup) when no address is found", async () => {
    const result = await service.handleInboundMessage({
      locationId: "loc_a",
      contactId: "ct_1",
      message: "hey",
    });

    expect(realEstate.searchPropertyByAddress).not.toHaveBeenCalled();
    expect(result.address).toBeNull();
    expect(ghlClient.sendSms).toHaveBeenCalledWith(
      "loc_a",
      expect.objectContaining({ contactId: "ct_1" })
    );
  });

  it("tenant A's inbound is NEVER sent on tenant B's location", async () => {
    realEstate.searchPropertyByAddress.mockResolvedValue(null);

    await service.handleInboundMessage({
      locationId: "loc_a",
      contactId: "ct_a",
      message: "hi",
    });
    await service.handleInboundMessage({
      locationId: "loc_b",
      contactId: "ct_b",
      message: "hi",
    });

    // Each reply went to exactly its own location — no crossover.
    const locationsUsed = ghlClient.sendSms.mock.calls.map(([loc]) => loc);
    expect(locationsUsed).toEqual(["loc_a", "loc_b"]);
    expect(ghlClient.sendSms).not.toHaveBeenCalledWith(
      "loc_b",
      expect.objectContaining({ contactId: "ct_a" })
    );
    expect(ghlClient.sendSms).not.toHaveBeenCalledWith(
      "loc_a",
      expect.objectContaining({ contactId: "ct_b" })
    );
  });
});
