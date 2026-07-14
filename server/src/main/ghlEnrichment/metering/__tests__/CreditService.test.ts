import { mock, MockProxy } from "jest-mock-extended";
import { GhlEnrichmentConfig } from "../../config/GhlEnrichmentConfig";
import { CreditService } from "../CreditService";
import { CreditSettingsService } from "../CreditSettingsService";
import { CreditLedgerRow, CreditLedgerStore } from "../CreditLedgerStore";

const configWith = (enrichment: number, skipTrace: number, textLookup = 1): GhlEnrichmentConfig =>
  ({
    creditCosts: {
      enrichmentBaseCredits: enrichment,
      skipTraceCredits: skipTrace,
      textLookupCredits: textLookup,
    },
  } as GhlEnrichmentConfig);

const ledgerRow = (over: Partial<CreditLedgerRow> = {}): CreditLedgerRow => ({
  id: "led-1",
  location_id: "loc_1",
  credit_type: "report",
  amount: -1,
  balance_after: 9,
  reason: "enrichment",
  contact_id: "ct_1",
  created_at: new Date("2026-07-01T00:00:00Z"),
  modified_at: new Date("2026-07-01T00:00:00Z"),
  deleted_at: null,
  ...over,
});

describe("CreditService", () => {
  let store: MockProxy<CreditLedgerStore>;
  let creditSettings: MockProxy<CreditSettingsService>;
  let service: CreditService;

  const newService = (config = configWith(1, 2)) =>
    new CreditService(store, config, creditSettings);

  beforeEach(() => {
    store = mock<CreditLedgerStore>();
    creditSettings = mock<CreditSettingsService>();
    creditSettings.defaultGrant.mockImplementation(
      async (type) => ({ report: 50, skiptrace: 10, comps: 10 }[type])
    );
    service = newService();
  });

  describe("costOf", () => {
    it("prices base only vs base + skip-trace from config", () => {
      expect(service.costOf({ skipTrace: false })).toBe(1);
      expect(service.costOf({ skipTrace: true })).toBe(3);
    });
  });

  describe("hasSufficientCredits", () => {
    it("is true when the balance covers the cost", async () => {
      store.getBalance.mockResolvedValue(3);
      expect(await service.hasSufficientCredits("loc_1", { skipTrace: true })).toBe(true);
    });

    it("is false when the balance is short", async () => {
      store.getBalance.mockResolvedValue(2);
      expect(await service.hasSufficientCredits("loc_1", { skipTrace: true })).toBe(false);
    });

    it("is true without a DB read when the operation is free (cost 0)", async () => {
      const free = newService(configWith(0, 0));
      expect(await free.hasSufficientCredits("loc_1", { skipTrace: true })).toBe(true);
      expect(store.getBalance).not.toHaveBeenCalled();
    });
  });

  describe("chargeForEnrichment (GHL — REPORT bucket)", () => {
    it("charges a single enrichment line against the report bucket without a skip-trace", async () => {
      store.charge.mockResolvedValue({ ok: true, balanceAfter: 9, entries: [ledgerRow()] });

      await service.chargeForEnrichment({ locationId: "loc_1", contactId: "ct_1", plan: { skipTrace: false } });

      expect(store.charge).toHaveBeenCalledWith({
        locationId: "loc_1",
        creditType: "report",
        contactId: "ct_1",
        lines: [{ reason: "enrichment", amount: 1 }],
      });
    });

    it("charges an itemized enrichment + skip_trace (both in the report bucket) when skip-tracing", async () => {
      store.charge.mockResolvedValue({ ok: true, balanceAfter: 7, entries: [] });

      await service.chargeForEnrichment({ locationId: "loc_1", contactId: "ct_1", plan: { skipTrace: true } });

      expect(store.charge).toHaveBeenCalledWith({
        locationId: "loc_1",
        creditType: "report",
        contactId: "ct_1",
        lines: [
          { reason: "enrichment", amount: 1 },
          { reason: "skip_trace", amount: 2 },
        ],
      });
    });

    it("is a free success when everything is priced at 0 — no charge issued", async () => {
      const free = newService(configWith(0, 0));
      store.getBalance.mockResolvedValue(5);

      const result = await free.chargeForEnrichment({
        locationId: "loc_1",
        contactId: "ct_1",
        plan: { skipTrace: false },
      });

      expect(result).toEqual({ ok: true, balanceAfter: 5, entries: [] });
      expect(store.charge).not.toHaveBeenCalled();
    });
  });

  describe("text-Jake report lookups (JAK-115 — REPORT bucket)", () => {
    it("prices a text lookup from config", () => {
      expect(service.costOfTextLookup()).toBe(1);
      expect(newService(configWith(1, 2, 3)).costOfTextLookup()).toBe(3);
    });

    it("checks affordability against the account's REPORT bucket", async () => {
      store.getBalance.mockResolvedValue(1);
      expect(await service.hasCreditsForTextLookup("acct_1")).toBe(true);
      expect(store.getBalance).toHaveBeenCalledWith("acct_1", "report");

      store.getBalance.mockResolvedValue(0);
      expect(await service.hasCreditsForTextLookup("acct_1")).toBe(false);
    });

    it("charges a text_lookup line to the REPORT bucket, NO contact-id dedup", async () => {
      store.charge.mockResolvedValue({ ok: true, balanceAfter: 4, entries: [] });

      await service.chargeForTextLookup({ accountId: "acct_1" });

      expect(store.charge).toHaveBeenCalledWith({
        locationId: "acct_1",
        creditType: "report",
        contactId: null,
        lines: [{ reason: "text_lookup", amount: 1 }],
      });
    });
  });

  describe("skip trace (JAK-136 — SKIPTRACE bucket)", () => {
    it("checks affordability against the SKIPTRACE bucket at the passed cost", async () => {
      store.getBalance.mockResolvedValue(3);
      expect(await service.hasCreditsForSkipTrace("acct_1", 3)).toBe(true);
      expect(store.getBalance).toHaveBeenCalledWith("acct_1", "skiptrace");

      store.getBalance.mockResolvedValue(2);
      expect(await service.hasCreditsForSkipTrace("acct_1", 3)).toBe(false);
    });

    it("charges a single skip_trace line to the SKIPTRACE bucket, NO contact-id dedup", async () => {
      store.charge.mockResolvedValue({ ok: true, balanceAfter: 7, entries: [] });

      await service.chargeForSkipTrace({ accountId: "acct_1", credits: 3 });

      expect(store.charge).toHaveBeenCalledWith({
        locationId: "acct_1",
        creditType: "skiptrace",
        contactId: null,
        lines: [{ reason: "skip_trace", amount: 3 }],
      });
    });

    it("surfaces the store's ok:false when the balance can't cover the trace (no partial charge)", async () => {
      store.charge.mockResolvedValue({ ok: false, balance: 1, required: 3 });
      const result = await service.chargeForSkipTrace({ accountId: "acct_1", credits: 3 });
      expect(result).toEqual({ ok: false, balance: 1, required: 3 });
    });
  });

  describe("comps (JAK-137 — COMPS bucket)", () => {
    it("checks affordability against the COMPS bucket at the passed cost", async () => {
      store.getBalance.mockResolvedValue(3);
      expect(await service.hasCreditsForComps("acct_1", 3)).toBe(true);
      expect(store.getBalance).toHaveBeenCalledWith("acct_1", "comps");
    });

    it("charges a single comps line to the COMPS bucket", async () => {
      store.charge.mockResolvedValue({ ok: true, balanceAfter: 7, entries: [] });

      await service.chargeForComps({ accountId: "acct_1", credits: 3 });

      expect(store.charge).toHaveBeenCalledWith({
        locationId: "acct_1",
        creditType: "comps",
        contactId: null,
        lines: [{ reason: "comps", amount: 3 }],
      });
    });
  });

  describe("typed per-bucket API (JAK-161)", () => {
    it("getBalance defaults to the report bucket and honors an explicit type", async () => {
      store.getBalance.mockResolvedValue(5);
      await service.getBalance("acct_1");
      expect(store.getBalance).toHaveBeenCalledWith("acct_1", "report");
      await service.getBalance("acct_1", "comps");
      expect(store.getBalance).toHaveBeenCalledWith("acct_1", "comps");
    });

    it("hasCredits reads only the named bucket (free when amount ≤ 0)", async () => {
      store.getBalance.mockResolvedValue(2);
      expect(await service.hasCredits("acct_1", "skiptrace", 3)).toBe(false);
      expect(store.getBalance).toHaveBeenCalledWith("acct_1", "skiptrace");
      expect(await service.hasCredits("acct_1", "comps", 0)).toBe(true);
    });

    it("charge routes to the named bucket with the given reason", async () => {
      store.charge.mockResolvedValue({ ok: true, balanceAfter: 7, entries: [] });
      await service.charge("acct_1", "comps", 3, "comps");
      expect(store.charge).toHaveBeenCalledWith({
        locationId: "acct_1",
        creditType: "comps",
        contactId: null,
        lines: [{ reason: "comps", amount: 3 }],
      });
    });

    it("grant routes to the named bucket, defaulting to report", async () => {
      store.grant.mockResolvedValue(ledgerRow({ amount: 5, reason: "manual_grant" }));
      await service.grant("acct_1", "skiptrace", 5);
      expect(store.grant).toHaveBeenCalledWith({
        locationId: "acct_1",
        creditType: "skiptrace",
        amount: 5,
        reason: "manual_grant",
      });
    });

    it("getBalances reads all three buckets independently", async () => {
      store.getBalance.mockImplementation(async (_acct, type) =>
        ({ report: 100, skiptrace: 7, comps: 3 }[type as string] ?? 0)
      );
      expect(await service.getBalances("acct_1")).toEqual({ report: 100, skiptrace: 7, comps: 3 });
    });
  });

  describe("seedNewCustomer (JAK-161)", () => {
    it("seeds all three buckets from the admin-editable defaults, idempotently", async () => {
      store.seedInitialBalance.mockResolvedValue(true);

      await service.seedNewCustomer("acct_new");

      expect(store.seedInitialBalance).toHaveBeenCalledWith({
        locationId: "acct_new",
        creditType: "report",
        amount: 50,
        reason: "manual_grant",
      });
      expect(store.seedInitialBalance).toHaveBeenCalledWith({
        locationId: "acct_new",
        creditType: "skiptrace",
        amount: 10,
        reason: "manual_grant",
      });
      expect(store.seedInitialBalance).toHaveBeenCalledWith({
        locationId: "acct_new",
        creditType: "comps",
        amount: 10,
        reason: "manual_grant",
      });
      expect(store.seedInitialBalance).toHaveBeenCalledTimes(3);
    });
  });

  describe("setBalance (JAK-reset-credits-button)", () => {
    it("grants the delta up when the target is above the current balance", async () => {
      store.getBalance.mockResolvedValue(3);
      store.grant.mockResolvedValue(ledgerRow({ amount: 47, reason: "adjustment", balance_after: 50 }));

      const result = await service.setBalance("acct_1", "report", 50);

      expect(result).toBe(50);
      expect(store.getBalance).toHaveBeenCalledWith("acct_1", "report");
      expect(store.grant).toHaveBeenCalledWith({
        locationId: "acct_1",
        creditType: "report",
        amount: 47,
        reason: "adjustment",
      });
      expect(store.charge).not.toHaveBeenCalled();
    });

    it("charges the delta down when the target is below the current balance", async () => {
      store.getBalance.mockResolvedValue(80);
      store.charge.mockResolvedValue({ ok: true, balanceAfter: 50, entries: [] });

      const result = await service.setBalance("acct_1", "report", 50);

      expect(result).toBe(50);
      expect(store.charge).toHaveBeenCalledWith({
        locationId: "acct_1",
        creditType: "report",
        contactId: null,
        lines: [{ reason: "adjustment", amount: 30 }],
      });
      expect(store.grant).not.toHaveBeenCalled();
    });

    it("is a no-op when the bucket is already at the target", async () => {
      store.getBalance.mockResolvedValue(50);

      const result = await service.setBalance("acct_1", "report", 50);

      expect(result).toBe(50);
      expect(store.grant).not.toHaveBeenCalled();
      expect(store.charge).not.toHaveBeenCalled();
    });

    it("rejects a negative or non-integer target", async () => {
      await expect(service.setBalance("acct_1", "report", -1)).rejects.toThrow(
        "non-negative integer"
      );
      await expect(service.setBalance("acct_1", "report", 1.5)).rejects.toThrow(
        "non-negative integer"
      );
    });
  });

  describe("resetToDefaults (JAK-reset-credits-button)", () => {
    it("sets all three buckets to the EFFECTIVE new-customer default (defaultGrant), same as seedNewCustomer", async () => {
      // Start every bucket empty so each reset is a grant-up of the default.
      store.getBalance.mockResolvedValue(0);
      store.grant.mockResolvedValue(ledgerRow({ reason: "adjustment" }));

      await service.resetToDefaults("acct_1");

      // The targets come from creditSettings.defaultGrant (50/10/10 by default),
      // NOT the frozen DEFAULT_GRANTS constant.
      expect(creditSettings.defaultGrant).toHaveBeenCalledWith("report");
      expect(creditSettings.defaultGrant).toHaveBeenCalledWith("skiptrace");
      expect(creditSettings.defaultGrant).toHaveBeenCalledWith("comps");
      expect(store.grant).toHaveBeenCalledWith({
        locationId: "acct_1",
        creditType: "report",
        amount: 50,
        reason: "adjustment",
      });
      expect(store.grant).toHaveBeenCalledWith({
        locationId: "acct_1",
        creditType: "skiptrace",
        amount: 10,
        reason: "adjustment",
      });
      expect(store.grant).toHaveBeenCalledWith({
        locationId: "acct_1",
        creditType: "comps",
        amount: 10,
        reason: "adjustment",
      });
    });

    it("honors an ADMIN-CUSTOMIZED default — reset gives what a new customer would now get", async () => {
      // Admin retuned the report default; reset must track it, not the frozen 50.
      creditSettings.defaultGrant.mockImplementation(
        async (type) => ({ report: 75, skiptrace: 10, comps: 10 }[type])
      );
      store.getBalance.mockResolvedValue(0);
      store.grant.mockResolvedValue(ledgerRow({ reason: "adjustment" }));

      await service.resetToDefaults("acct_1");

      expect(store.grant).toHaveBeenCalledWith({
        locationId: "acct_1",
        creditType: "report",
        amount: 75,
        reason: "adjustment",
      });
    });

    it("returns the resulting balances read back from the ledger", async () => {
      store.grant.mockResolvedValue(ledgerRow({ reason: "adjustment" }));
      // The read-back after the sets returns the defaults now on the account.
      store.getBalance.mockImplementation(async (_acct, type) =>
        ({ report: 50, skiptrace: 10, comps: 10 }[type as string] ?? 0)
      );

      expect(await service.resetToDefaults("acct_1")).toEqual({
        report: 50,
        skiptrace: 10,
        comps: 10,
      });
    });
  });

  describe("grantCredits", () => {
    it("grants to the report bucket by default, defaulting the reason to manual_grant", async () => {
      store.grant.mockResolvedValue(ledgerRow({ amount: 100, reason: "manual_grant" }));
      await service.grantCredits("loc_1", 100);
      expect(store.grant).toHaveBeenCalledWith({
        locationId: "loc_1",
        creditType: "report",
        amount: 100,
        reason: "manual_grant",
      });
    });

    it("grants to an explicit bucket when one is passed (JAK-162 top-up)", async () => {
      store.grant.mockResolvedValue(ledgerRow({ amount: 5, reason: "manual_grant" }));
      await service.grantCredits("loc_1", 5, "manual_grant", "comps");
      expect(store.grant).toHaveBeenCalledWith({
        locationId: "loc_1",
        creditType: "comps",
        amount: 5,
        reason: "manual_grant",
      });
    });
  });

  describe("refundEnrichment", () => {
    it("reverses a contact's charge via the ledger, defaulting the reason to refund", async () => {
      store.refund.mockResolvedValue(ledgerRow({ amount: 1, reason: "refund" }));

      const row = await service.refundEnrichment({ locationId: "loc_1", contactId: "ct_1" });

      expect(store.refund).toHaveBeenCalledWith({
        locationId: "loc_1",
        contactId: "ct_1",
        reason: "refund",
      });
      expect(row?.reason).toBe("refund");
    });

    it("returns null when there was nothing to refund (idempotent no-op)", async () => {
      store.refund.mockResolvedValue(null);
      expect(await service.refundEnrichment({ locationId: "loc_1", contactId: "ct_1" })).toBeNull();
    });
  });

  describe("getAccountSummary", () => {
    it("returns the REPORT balance and recent ledger for a location", async () => {
      store.getBalance.mockResolvedValue(8);
      const recent = [ledgerRow()];
      store.recentEntries.mockResolvedValue(recent);

      const summary = await service.getAccountSummary("loc_1");

      expect(store.getBalance).toHaveBeenCalledWith("loc_1", "report");
      expect(summary).toEqual({ locationId: "loc_1", balance: 8, recent });
    });
  });
});
