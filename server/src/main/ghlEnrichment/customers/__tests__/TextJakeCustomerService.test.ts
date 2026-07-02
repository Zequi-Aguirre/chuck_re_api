import { mock, MockProxy } from "jest-mock-extended";
import { TextJakeCustomerService, normalizePhone } from "../TextJakeCustomerService";
import { TextJakeCustomerRow, TextJakeCustomerStore } from "../TextJakeCustomerStore";

/**
 * The text-Jake customer service (JAK-115) is the tier-1 billing identity. These
 * tests pin: a phone resolves to a stable customer + credit account, two phones
 * never share an account (billing isolation), phones are normalized so the same
 * number can't split, and the GHL contact link is passed through.
 */
describe("TextJakeCustomerService", () => {
  let store: MockProxy<TextJakeCustomerStore>;
  let service: TextJakeCustomerService;

  const row = (over: Partial<TextJakeCustomerRow> = {}): TextJakeCustomerRow => ({
    id: "cust-1111",
    phone: "+15559990000",
    ghl_contact_id: null,
    created_at: new Date("2026-07-01T00:00:00Z"),
    modified_at: new Date("2026-07-01T00:00:00Z"),
    deleted_at: null,
    ...over,
  });

  beforeEach(() => {
    store = mock<TextJakeCustomerStore>();
    service = new TextJakeCustomerService(store);
  });

  it("resolves a phone to a customer whose credit account is its stable id", async () => {
    store.upsertByPhone.mockResolvedValue(row({ id: "cust-abc", phone: "+15559990000" }));

    const customer = await service.resolveByPhone("+15559990000");

    expect(store.upsertByPhone).toHaveBeenCalledWith("+15559990000", null);
    expect(customer.id).toBe("cust-abc");
    expect(customer.creditAccountId).toBe("cust-abc");
  });

  it("passes the GHL contact id through to the upsert when known", async () => {
    store.upsertByPhone.mockResolvedValue(row({ ghl_contact_id: "ct_1" }));

    const customer = await service.resolveByPhone("+15559990000", "ct_1");

    expect(store.upsertByPhone).toHaveBeenCalledWith("+15559990000", "ct_1");
    expect(customer.ghlContactId).toBe("ct_1");
  });

  it("maps two different phones to two different credit accounts (isolation)", async () => {
    store.upsertByPhone.mockImplementation(async (phone) =>
      row({ id: `cust_${phone}`, phone })
    );

    const a = await service.resolveByPhone("+15550001111");
    const b = await service.resolveByPhone("+15550002222");

    expect(a.creditAccountId).not.toBe(b.creditAccountId);
    expect(a.creditAccountId).toBe("cust_+15550001111");
    expect(b.creditAccountId).toBe("cust_+15550002222");
  });

  it("normalizes the phone before resolving (no split on stray whitespace)", async () => {
    store.upsertByPhone.mockResolvedValue(row());

    await service.resolveByPhone("  +1 555 999 0000 ");

    expect(store.upsertByPhone).toHaveBeenCalledWith("+15559990000", null);
  });

  it("normalizePhone strips whitespace", () => {
    expect(normalizePhone("  +1 555 123 4567 ")).toBe("+15551234567");
  });
});
