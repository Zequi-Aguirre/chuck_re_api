import { mock, MockProxy } from "jest-mock-extended";
import { GhlEnrichmentConfig } from "../../config/GhlEnrichmentConfig";
import { CreditService } from "../../metering/CreditService";
import {
  CreditLedgerRow,
  CreditLedgerStore,
  LocationBalance,
} from "../../metering/CreditLedgerStore";
import { TextJakeCustomerService } from "../../customers/TextJakeCustomerService";
import { TextJakeCustomerStore, TextJakeCustomerRow } from "../../customers/TextJakeCustomerStore";
import { TextJakeCustomer } from "../../customers/TextJakeCustomerTypes";
import { AdminTextCustomerService } from "../AdminTextCustomerService";

const config = (textLookup = 1): GhlEnrichmentConfig =>
  ({
    creditCosts: {
      enrichmentBaseCredits: 1,
      skipTraceCredits: 2,
      textLookupCredits: textLookup,
    },
  } as GhlEnrichmentConfig);

/**
 * A tiny stateful stand-in for the ledger store: keeps per-account balances in a
 * Map so a grant and a later balance read see the SAME account. This is what
 * proves the account-key wiring — that granting by phone lands on the same key
 * (the customer id) that {@link CreditService.hasCreditsForTextLookup} reads.
 */
function inMemoryLedger(): CreditLedgerStore {
  const balances = new Map<string, number>();
  const fake = {
    async getBalance(accountId: string): Promise<number> {
      return balances.get(accountId) ?? 0;
    },
    async listBalances(): Promise<LocationBalance[]> {
      return [...balances.entries()].map(([location_id, balance]) => ({ location_id, balance }));
    },
    async grant(input: { locationId: string; amount: number }): Promise<CreditLedgerRow> {
      const next = (balances.get(input.locationId) ?? 0) + input.amount;
      balances.set(input.locationId, next);
      return {
        id: `led-${input.locationId}`,
        location_id: input.locationId,
        amount: input.amount,
        balance_after: next,
        reason: "manual_grant",
        contact_id: null,
        created_at: new Date("2026-07-01T00:00:00Z"),
        modified_at: new Date("2026-07-01T00:00:00Z"),
        deleted_at: null,
      };
    },
  };
  return fake as unknown as CreditLedgerStore;
}

const customer = (over: Partial<TextJakeCustomer> = {}): TextJakeCustomer => ({
  id: "cust-1",
  phone: "+17865274077",
  ghlContactId: null,
  // The credit account key IS the customer id (JAK-115).
  creditAccountId: "cust-1",
  createdAt: new Date("2026-07-01T00:00:00Z"),
  modifiedAt: new Date("2026-07-02T00:00:00Z"),
  ...over,
});

const customerRow = (over: Partial<TextJakeCustomerRow> = {}): TextJakeCustomerRow => ({
  id: "cust-1",
  phone: "+17865274077",
  ghl_contact_id: null,
  created_at: new Date("2026-07-01T00:00:00Z"),
  modified_at: new Date("2026-07-02T00:00:00Z"),
  deleted_at: null,
  ...over,
});

describe("AdminTextCustomerService", () => {
  let customers: MockProxy<TextJakeCustomerService>;
  let customerStore: MockProxy<TextJakeCustomerStore>;
  let ledger: CreditLedgerStore;
  let credits: CreditService;
  let service: AdminTextCustomerService;

  beforeEach(() => {
    customers = mock<TextJakeCustomerService>();
    customerStore = mock<TextJakeCustomerStore>();
    ledger = inMemoryLedger();
    credits = new CreditService(ledger, config());
    service = new AdminTextCustomerService(customers, customerStore, credits, ledger);
  });

  it("grants credits BY PHONE onto the customer's own account, unblocking text lookups", async () => {
    // The texter who ran "out of Jake credits" — resolved (or created) by phone.
    customers.resolveByPhone.mockResolvedValue(customer());

    // Before: no credits, so a text lookup can't be afforded.
    expect(await credits.hasCreditsForTextLookup("cust-1")).toBe(false);

    const result = await service.grantCredits("+17865274077", 5);

    // Credits landed on the CUSTOMER's account key (its id), NOT a location id.
    expect(customers.resolveByPhone).toHaveBeenCalledWith("+17865274077");
    expect(result.balance).toBe(5);
    expect(result.customer.id).toBe("cust-1");
    expect(result.entry.location_id).toBe("cust-1");
    expect(await credits.getBalance("cust-1")).toBe(5);

    // After: the gate the text path checks now passes.
    expect(await credits.hasCreditsForTextLookup("cust-1")).toBe(true);
  });

  it("credits a number that has never texted in (resolve-or-create by phone)", async () => {
    // resolveByPhone upserts, so a brand-new phone gets a fresh account.
    customers.resolveByPhone.mockResolvedValue(customer({ id: "new-cust", creditAccountId: "new-cust" }));

    const result = await service.grantCredits("+15550001111", 3);

    expect(result.balance).toBe(3);
    expect(await credits.hasCreditsForTextLookup("new-cust")).toBe(true);
  });

  it("lists customers with their credit balances joined by account key", async () => {
    customerStore.listAll.mockResolvedValue([
      customerRow({ id: "cust-1", phone: "+17865274077" }),
      customerRow({ id: "cust-2", phone: "+15559998888" }),
    ]);
    // cust-1 has been topped up; cust-2 has no ledger activity yet.
    await ledger.grant({ locationId: "cust-1", amount: 8, reason: "manual_grant" });

    const list = await service.list();

    expect(list).toHaveLength(2);
    const byId = new Map(list.map((c) => [c.id, c]));
    expect(byId.get("cust-1")?.creditBalance).toBe(8);
    expect(byId.get("cust-1")?.phone).toBe("+17865274077");
    // A customer with no ledger row reads as balance 0, not undefined.
    expect(byId.get("cust-2")?.creditBalance).toBe(0);
  });
});
