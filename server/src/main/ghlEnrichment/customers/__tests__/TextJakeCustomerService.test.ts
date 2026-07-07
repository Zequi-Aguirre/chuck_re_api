import { mock, MockProxy } from "jest-mock-extended";
import { TextJakeCustomerService, normalizePhone } from "../TextJakeCustomerService";
import { TextJakeCustomerRow, TextJakeCustomerStore } from "../TextJakeCustomerStore";
import { CreditService } from "../../metering/CreditService";

/**
 * The text-Jake customer service (JAK-115) is the tier-1 billing identity. These
 * tests pin: a phone resolves to a stable customer + credit account, two phones
 * never share an account (billing isolation), phones are normalized so the same
 * number can't split, the GHL contact link is passed through, and a genuinely NEW
 * customer has their three credit buckets seeded (JAK-161).
 */
describe("TextJakeCustomerService", () => {
  let store: MockProxy<TextJakeCustomerStore>;
  let credits: MockProxy<CreditService>;
  let service: TextJakeCustomerService;

  /** Shorthand for the store's upsert result: the row + whether it was just created. */
  const upserted = (r: TextJakeCustomerRow, created = false) => ({ row: r, created });

  const row = (over: Partial<TextJakeCustomerRow> = {}): TextJakeCustomerRow => ({
    id: "cust-1111",
    phone: "+15559990000",
    ghl_contact_id: null,
    first_name: null,
    last_name: null,
    email: null,
    status: "active",
    report_count: 0,
    onboarding_asked_at: null,
    next_reset_at: new Date("2026-08-01T00:00:00Z"),
    created_at: new Date("2026-07-01T00:00:00Z"),
    modified_at: new Date("2026-07-01T00:00:00Z"),
    deleted_at: null,
    ...over,
  });

  beforeEach(() => {
    store = mock<TextJakeCustomerStore>();
    credits = mock<CreditService>();
    service = new TextJakeCustomerService(store, credits);
  });

  it("resolves a phone to a customer whose credit account is its stable id", async () => {
    store.upsertByPhone.mockResolvedValue(upserted(row({ id: "cust-abc", phone: "+15559990000" })));

    const customer = await service.resolveByPhone("+15559990000");

    expect(store.upsertByPhone).toHaveBeenCalledWith("+15559990000", null);
    expect(customer.id).toBe("cust-abc");
    expect(customer.creditAccountId).toBe("cust-abc");
  });

  it("passes the GHL contact id through to the upsert when known", async () => {
    store.upsertByPhone.mockResolvedValue(upserted(row({ ghl_contact_id: "ct_1" })));

    const customer = await service.resolveByPhone("+15559990000", "ct_1");

    expect(store.upsertByPhone).toHaveBeenCalledWith("+15559990000", "ct_1");
    expect(customer.ghlContactId).toBe("ct_1");
  });

  it("maps two different phones to two different credit accounts (isolation)", async () => {
    store.upsertByPhone.mockImplementation(async (phone) =>
      upserted(row({ id: `cust_${phone}`, phone }))
    );

    const a = await service.resolveByPhone("+15550001111");
    const b = await service.resolveByPhone("+15550002222");

    expect(a.creditAccountId).not.toBe(b.creditAccountId);
    expect(a.creditAccountId).toBe("cust_+15550001111");
    expect(b.creditAccountId).toBe("cust_+15550002222");
  });

  it("normalizes the phone before resolving (no split on stray whitespace)", async () => {
    store.upsertByPhone.mockResolvedValue(upserted(row()));

    await service.resolveByPhone("  +1 555 999 0000 ");

    expect(store.upsertByPhone).toHaveBeenCalledWith("+15559990000", null);
  });

  it("seeds the three credit buckets ONLY when the customer is genuinely new (JAK-161)", async () => {
    // Fresh insert → seed once, keyed on the new customer's stable id.
    store.upsertByPhone.mockResolvedValue(upserted(row({ id: "cust-new" }), true));
    await service.resolveByPhone("+15559990000");
    expect(credits.seedNewCustomer).toHaveBeenCalledWith("cust-new");

    credits.seedNewCustomer.mockClear();

    // Returning texter (ON CONFLICT update) → never re-seeded, so no extra grants.
    store.upsertByPhone.mockResolvedValue(upserted(row({ id: "cust-new" }), false));
    await service.resolveByPhone("+15559990000");
    expect(credits.seedNewCustomer).not.toHaveBeenCalled();
  });

  it("normalizePhone strips whitespace", () => {
    expect(normalizePhone("  +1 555 123 4567 ")).toBe("+15551234567");
  });

  it("resolveByPhoneWithCreation reports whether THIS call created the customer", async () => {
    store.upsertByPhone.mockResolvedValue(upserted(row({ id: "cust-new" }), true));
    const fresh = await service.resolveByPhoneWithCreation("+15559990000", "ct_1");
    expect(fresh.created).toBe(true);
    expect(fresh.customer.id).toBe("cust-new");
    expect(credits.seedNewCustomer).toHaveBeenCalledWith("cust-new");

    store.upsertByPhone.mockResolvedValue(upserted(row({ id: "cust-new" }), false));
    const returning = await service.resolveByPhoneWithCreation("+15559990000");
    expect(returning.created).toBe(false);
  });

  it("maps the new report-count + onboarding-stamp fields through (JAK-first-text-welcome)", async () => {
    store.upsertByPhone.mockResolvedValue(
      upserted(row({ report_count: 2, onboarding_asked_at: new Date("2026-07-07T00:00:00Z") }))
    );
    const customer = await service.resolveByPhone("+15559990000");
    expect(customer.reportCount).toBe(2);
    expect(customer.onboardingAskedAt).toEqual(new Date("2026-07-07T00:00:00Z"));
  });

  it("delegates incrementReportCount / markOnboardingAsked / captureProfile to the store", async () => {
    store.incrementReportCount.mockResolvedValue(3);
    expect(await service.incrementReportCount("cust-1")).toBe(3);
    expect(store.incrementReportCount).toHaveBeenCalledWith("cust-1");

    store.markOnboardingAsked.mockResolvedValue(true);
    expect(await service.markOnboardingAsked("cust-1")).toBe(true);

    store.captureProfile.mockResolvedValue(row({ first_name: "Sara", email: "sara@example.com" }));
    const updated = await service.captureProfile("cust-1", { firstName: "Sara", email: "sara@example.com" });
    expect(store.captureProfile).toHaveBeenCalledWith("cust-1", {
      firstName: "Sara",
      email: "sara@example.com",
    });
    expect(updated?.firstName).toBe("Sara");
    expect(updated?.email).toBe("sara@example.com");
  });
});
