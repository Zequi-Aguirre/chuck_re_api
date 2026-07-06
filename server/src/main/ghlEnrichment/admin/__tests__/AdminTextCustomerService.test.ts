import { mock, MockProxy } from "jest-mock-extended";
import { GhlEnrichmentConfig } from "../../config/GhlEnrichmentConfig";
import { CreditService } from "../../metering/CreditService";
import { CreditSettingsService } from "../../metering/CreditSettingsService";
import {
  CreditLedgerRow,
  CreditLedgerStore,
  LocationBalance,
} from "../../metering/CreditLedgerStore";
import { TextJakeCustomerService } from "../../customers/TextJakeCustomerService";
import { TextJakeCustomerStore, TextJakeCustomerRow } from "../../customers/TextJakeCustomerStore";
import { TextJakeCustomer } from "../../customers/TextJakeCustomerTypes";
import {
  TextCustomerGhlSyncService,
  TextCustomerSyncResult,
} from "../../customers/TextCustomerGhlSyncService";
import { AdminTextCustomerService } from "../AdminTextCustomerService";

/** The default off-prod sync outcome — no contact id, nothing persisted. */
const skippedSync: TextCustomerSyncResult = {
  status: "skipped",
  ghlContactId: null,
  message: "Saved. Syncing to GoHighLevel runs in staging and production only.",
};

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
  // Bucket-aware (JAK-161): keyed by "accountId|creditType" so report / skiptrace
  // / comps balances stay independent, as the real composite-PK store does.
  const balances = new Map<string, number>();
  const key = (accountId: string, creditType = "report") => `${accountId}|${creditType}`;
  const fake = {
    async getBalance(accountId: string, creditType = "report"): Promise<number> {
      return balances.get(key(accountId, creditType)) ?? 0;
    },
    async listBalances(creditType = "report"): Promise<LocationBalance[]> {
      return [...balances.entries()]
        .filter(([k]) => k.endsWith(`|${creditType}`))
        .map(([k, balance]) => ({ location_id: k.split("|")[0], balance }));
    },
    async grant(input: {
      locationId: string;
      creditType?: string;
      amount: number;
    }): Promise<CreditLedgerRow> {
      const creditType = input.creditType ?? "report";
      const next = (balances.get(key(input.locationId, creditType)) ?? 0) + input.amount;
      balances.set(key(input.locationId, creditType), next);
      return {
        id: `led-${input.locationId}-${creditType}`,
        location_id: input.locationId,
        credit_type: creditType,
        amount: input.amount,
        balance_after: next,
        reason: "manual_grant",
        contact_id: null,
        created_at: new Date("2026-07-01T00:00:00Z"),
        modified_at: new Date("2026-07-01T00:00:00Z"),
        deleted_at: null,
      };
    },
    async seedInitialBalance(input: {
      locationId: string;
      creditType: string;
      amount: number;
    }): Promise<boolean> {
      const k = key(input.locationId, input.creditType);
      if (balances.has(k)) return false;
      balances.set(k, input.amount);
      return true;
    },
  };
  return fake as unknown as CreditLedgerStore;
}

const customer = (over: Partial<TextJakeCustomer> = {}): TextJakeCustomer => ({
  id: "cust-1",
  phone: "+17865274077",
  ghlContactId: null,
  firstName: null,
  lastName: null,
  email: null,
  status: "active",
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
  first_name: null,
  last_name: null,
  email: null,
  status: "active",
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
  let sync: MockProxy<TextCustomerGhlSyncService>;
  let service: AdminTextCustomerService;

  beforeEach(() => {
    customers = mock<TextJakeCustomerService>();
    customerStore = mock<TextJakeCustomerStore>();
    ledger = inMemoryLedger();
    const creditSettings = mock<CreditSettingsService>();
    creditSettings.defaultGrant.mockImplementation(async (type) =>
      ({ report: 100, skiptrace: 10, comps: 10 }[type])
    );
    credits = new CreditService(ledger, config(), creditSettings);
    sync = mock<TextCustomerGhlSyncService>();
    // Default: the off-prod "skipped" outcome so create/update don't try to
    // persist a contact id unless a test opts into a live sync.
    sync.syncCustomer.mockResolvedValue(skippedSync);
    service = new AdminTextCustomerService(customers, customerStore, credits, ledger, sync);
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

  it("creates a customer with a normalized phone + profile, seeded to the default report balance (JAK-146/161)", async () => {
    customerStore.create.mockResolvedValue(
      customerRow({ first_name: "Ada", last_name: "Lovelace", email: "ada@example.com" })
    );

    const { customer } = await service.create({
      phone: " +1 786 527 4077 ",
      firstName: "Ada",
      lastName: "Lovelace",
      email: "ada@example.com",
    });

    // Phone normalized (whitespace stripped) before it hits the store.
    expect(customerStore.create).toHaveBeenCalledWith("+17865274077", {
      firstName: "Ada",
      lastName: "Lovelace",
      email: "ada@example.com",
    });
    expect(customer.firstName).toBe("Ada");
    expect(customer.email).toBe("ada@example.com");
    // JAK-161: a brand-new customer is seeded from the default grants, so the
    // returned (report) balance is the 100-credit report default, not 0.
    expect(customer.creditBalance).toBe(100);
  });

  it("seeds the three per-feature credit buckets on create (JAK-161)", async () => {
    customerStore.create.mockResolvedValue(customerRow({ id: "cust-seeded" }));

    await service.create({ phone: "+17865270000", firstName: null, lastName: null, email: null });

    // The three independent buckets are seeded from the defaults (100/10/10).
    expect(await credits.getBalance("cust-seeded", "report")).toBe(100);
    expect(await credits.getBalance("cust-seeded", "skiptrace")).toBe(10);
    expect(await credits.getBalance("cust-seeded", "comps")).toBe(10);
  });

  it("syncs a created customer to the Jake sub-account and returns the sync outcome (JAK-147)", async () => {
    customerStore.create.mockResolvedValue(
      customerRow({ first_name: "Ada", email: "ada@example.com" })
    );
    // A live sync resolves a contact id, which the service persists back.
    sync.syncCustomer.mockResolvedValue({
      status: "synced",
      ghlContactId: "ghl_1",
      message: "Synced to GoHighLevel and approved to text Jake.",
    });
    customerStore.setGhlContactId.mockResolvedValue(
      customerRow({ first_name: "Ada", email: "ada@example.com", ghl_contact_id: "ghl_1" })
    );

    const { customer, sync: result } = await service.create({
      phone: " +1 786 527 4077 ",
      firstName: "Ada",
      lastName: null,
      email: "ada@example.com",
    });

    // The normalized phone + profile are pushed to GHL...
    expect(sync.syncCustomer).toHaveBeenCalledWith({
      phone: "+17865274077",
      firstName: "Ada",
      lastName: null,
      email: "ada@example.com",
    });
    // ...and the resolved contact id is persisted + reflected in the view.
    expect(customerStore.setGhlContactId).toHaveBeenCalledWith("cust-1", "ghl_1");
    expect(customer.ghlContactId).toBe("ghl_1");
    expect(result.status).toBe("synced");
  });

  it("does NOT persist a contact id when the sync is skipped/failed (JAK-147)", async () => {
    customerStore.create.mockResolvedValue(customerRow());
    // Default skippedSync has no ghlContactId.
    await service.create({ phone: "+17865274077", firstName: null, lastName: null, email: null });
    expect(customerStore.setGhlContactId).not.toHaveBeenCalled();
  });

  it("updates a customer's profile and returns the view with its current balance (JAK-146)", async () => {
    customerStore.updateProfile.mockResolvedValue(
      customerRow({ id: "cust-1", first_name: "Grace", email: "grace@example.com" })
    );
    // Balance is read from the ledger, not reset by the profile edit.
    await ledger.grant({ locationId: "cust-1", amount: 6, reason: "manual_grant" });

    const result = await service.update("cust-1", {
      phone: "+17865274077",
      firstName: "Grace",
      lastName: "Hopper",
      email: "grace@example.com",
    });

    expect(customerStore.updateProfile).toHaveBeenCalledWith("cust-1", "+17865274077", {
      firstName: "Grace",
      lastName: "Hopper",
      email: "grace@example.com",
    });
    expect(result?.customer.firstName).toBe("Grace");
    expect(result?.customer.creditBalance).toBe(6);
    // An edit also re-syncs to GHL (idempotent upsert by phone).
    expect(sync.syncCustomer).toHaveBeenCalledWith({
      phone: "+17865274077",
      firstName: "Grace",
      lastName: "Hopper",
      email: "grace@example.com",
    });
  });

  it("returns null when updating an unknown customer, without syncing (JAK-146/147)", async () => {
    customerStore.updateProfile.mockResolvedValue(null);
    const result = await service.update("nope", {
      phone: "+17865274077",
      firstName: null,
      lastName: null,
      email: null,
    });
    expect(result).toBeNull();
    // No live customer → nothing to sync.
    expect(sync.syncCustomer).not.toHaveBeenCalled();
  });

  it("delegates find-contact to the sync service with a normalized phone (JAK-147)", async () => {
    sync.findContact.mockResolvedValue({
      found: true,
      contact: { ghlContactId: "ghl_1", firstName: "Ada", lastName: null, email: "ada@example.com" },
      message: "Found an existing GoHighLevel contact.",
    });

    const res = await service.findContact(" +1 786 527 4077 ");

    expect(sync.findContact).toHaveBeenCalledWith("+17865274077");
    expect(res.found).toBe(true);
    expect(res.contact?.ghlContactId).toBe("ghl_1");
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

  // --- Two-level hold status changes (JAK-148) ------------------------------

  describe("changeStatus (JAK-148)", () => {
    it("on_hold: persists the status and does NOT flip the GHL approval field", async () => {
      customerStore.setStatus.mockResolvedValue(customerRow({ status: "on_hold" }));

      const result = await service.changeStatus("cust-1", "on_hold");

      expect(customerStore.setStatus).toHaveBeenCalledWith("cust-1", "on_hold");
      // SOFT hold: GHL keeps forwarding, so the approval field is left untouched.
      expect(sync.setApproval).not.toHaveBeenCalled();
      expect(result?.customer.status).toBe("on_hold");
      expect(result?.sync).toBeNull();
    });

    it("deactivated: persists and flips 'text Jake' to UNAPPROVED via the sync", async () => {
      customerStore.setStatus.mockResolvedValue(customerRow({ status: "deactivated" }));
      sync.setApproval.mockResolvedValue({
        status: "synced",
        ghlContactId: "ghl_1",
        message: "Updated in GoHighLevel — texts to Jake are turned off.",
      });

      const result = await service.changeStatus("cust-1", "deactivated");

      expect(customerStore.setStatus).toHaveBeenCalledWith("cust-1", "deactivated");
      // approved=false → GHL stops forwarding.
      expect(sync.setApproval).toHaveBeenCalledWith(
        { phone: "+17865274077", firstName: null, lastName: null, email: null },
        false
      );
      expect(result?.customer.status).toBe("deactivated");
      expect(result?.sync?.status).toBe("synced");
    });

    it("active: persists and RE-APPROVES 'text Jake' so GHL forwards again", async () => {
      customerStore.setStatus.mockResolvedValue(customerRow({ status: "active" }));
      sync.setApproval.mockResolvedValue({
        status: "synced",
        ghlContactId: "ghl_1",
        message: "Synced to GoHighLevel and approved to text Jake.",
      });

      const result = await service.changeStatus("cust-1", "active");

      expect(sync.setApproval).toHaveBeenCalledWith(
        { phone: "+17865274077", firstName: null, lastName: null, email: null },
        true
      );
      expect(result?.customer.status).toBe("active");
    });

    it("returns null when no live customer has that id", async () => {
      customerStore.setStatus.mockResolvedValue(null);

      const result = await service.changeStatus("nope", "on_hold");

      expect(result).toBeNull();
      expect(sync.setApproval).not.toHaveBeenCalled();
    });

    it("NEVER moves the credit balance across a hold/deactivate/reactivate", async () => {
      // Seed a balance, then run every transition and assert it's unchanged.
      await ledger.grant({ locationId: "cust-1", amount: 7, reason: "manual_grant" });
      sync.setApproval.mockResolvedValue(skippedSync);

      for (const status of ["on_hold", "deactivated", "active"] as const) {
        customerStore.setStatus.mockResolvedValue(customerRow({ status }));
        const result = await service.changeStatus("cust-1", status);
        expect(result?.customer.creditBalance).toBe(7);
      }
      expect(await credits.getBalance("cust-1")).toBe(7);
    });
  });
});
