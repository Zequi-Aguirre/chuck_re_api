import { mock, MockProxy } from "jest-mock-extended";
import { GhlEnrichmentConfig } from "../../config/GhlEnrichmentConfig";
import { CreditService } from "../CreditService";
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
  let service: CreditService;

  beforeEach(() => {
    store = mock<CreditLedgerStore>();
    service = new CreditService(store, configWith(1, 2));
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
      const free = new CreditService(store, configWith(0, 0));
      expect(await free.hasSufficientCredits("loc_1", { skipTrace: true })).toBe(true);
      expect(store.getBalance).not.toHaveBeenCalled();
    });
  });

  describe("chargeForEnrichment", () => {
    it("charges a single enrichment line without a skip-trace", async () => {
      store.charge.mockResolvedValue({ ok: true, balanceAfter: 9, entries: [ledgerRow()] });

      await service.chargeForEnrichment({ locationId: "loc_1", contactId: "ct_1", plan: { skipTrace: false } });

      expect(store.charge).toHaveBeenCalledWith({
        locationId: "loc_1",
        contactId: "ct_1",
        lines: [{ reason: "enrichment", amount: 1 }],
      });
    });

    it("charges an itemized enrichment + skip_trace when skip-tracing", async () => {
      store.charge.mockResolvedValue({ ok: true, balanceAfter: 7, entries: [] });

      await service.chargeForEnrichment({ locationId: "loc_1", contactId: "ct_1", plan: { skipTrace: true } });

      expect(store.charge).toHaveBeenCalledWith({
        locationId: "loc_1",
        contactId: "ct_1",
        lines: [
          { reason: "enrichment", amount: 1 },
          { reason: "skip_trace", amount: 2 },
        ],
      });
    });

    it("is a free success when everything is priced at 0 — no charge issued", async () => {
      const free = new CreditService(store, configWith(0, 0));
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

  describe("text-Jake lookups (JAK-115)", () => {
    it("prices a text lookup from config", () => {
      expect(service.costOfTextLookup()).toBe(1);
      expect(new CreditService(store, configWith(1, 2, 3)).costOfTextLookup()).toBe(3);
    });

    it("checks affordability against the customer's credit account", async () => {
      store.getBalance.mockResolvedValue(1);
      expect(await service.hasCreditsForTextLookup("acct_1")).toBe(true);
      expect(store.getBalance).toHaveBeenCalledWith("acct_1");

      store.getBalance.mockResolvedValue(0);
      expect(await service.hasCreditsForTextLookup("acct_1")).toBe(false);
    });

    it("is free (no DB read) when the lookup is priced at 0", async () => {
      const free = new CreditService(store, configWith(1, 2, 0));
      expect(await free.hasCreditsForTextLookup("acct_1")).toBe(true);
      expect(store.getBalance).not.toHaveBeenCalled();
    });

    it("charges a text_lookup line to the account with NO contact-id dedup (each text bills)", async () => {
      store.charge.mockResolvedValue({ ok: true, balanceAfter: 4, entries: [] });

      await service.chargeForTextLookup({ accountId: "acct_1" });

      expect(store.charge).toHaveBeenCalledWith({
        locationId: "acct_1",
        contactId: null,
        lines: [{ reason: "text_lookup", amount: 1 }],
      });
    });

    it("is a free success when the lookup is priced at 0 — no charge issued", async () => {
      const free = new CreditService(store, configWith(1, 2, 0));
      store.getBalance.mockResolvedValue(5);

      const result = await free.chargeForTextLookup({ accountId: "acct_1" });

      expect(result).toEqual({ ok: true, balanceAfter: 5, entries: [] });
      expect(store.charge).not.toHaveBeenCalled();
    });
  });

  describe("skip trace (JAK-136)", () => {
    it("checks affordability against the customer's account at the passed cost", async () => {
      store.getBalance.mockResolvedValue(3);
      expect(await service.hasCreditsForSkipTrace("acct_1", 3)).toBe(true);
      expect(store.getBalance).toHaveBeenCalledWith("acct_1");

      store.getBalance.mockResolvedValue(2);
      expect(await service.hasCreditsForSkipTrace("acct_1", 3)).toBe(false);
    });

    it("is affordable without a DB read when the cost is 0", async () => {
      expect(await service.hasCreditsForSkipTrace("acct_1", 0)).toBe(true);
      expect(store.getBalance).not.toHaveBeenCalled();
    });

    it("charges a single skip_trace line at the passed cost, NO contact-id dedup", async () => {
      store.charge.mockResolvedValue({ ok: true, balanceAfter: 7, entries: [] });

      await service.chargeForSkipTrace({ accountId: "acct_1", credits: 3 });

      expect(store.charge).toHaveBeenCalledWith({
        locationId: "acct_1",
        contactId: null,
        lines: [{ reason: "skip_trace", amount: 3 }],
      });
    });

    it("surfaces the store's ok:false when the balance can't cover the trace (no partial charge)", async () => {
      store.charge.mockResolvedValue({ ok: false, balance: 1, required: 3 });
      const result = await service.chargeForSkipTrace({ accountId: "acct_1", credits: 3 });
      expect(result).toEqual({ ok: false, balance: 1, required: 3 });
    });

    it("is a free success (no charge issued) when the cost is 0", async () => {
      store.getBalance.mockResolvedValue(5);
      const result = await service.chargeForSkipTrace({ accountId: "acct_1", credits: 0 });
      expect(result).toEqual({ ok: true, balanceAfter: 5, entries: [] });
      expect(store.charge).not.toHaveBeenCalled();
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
      expect(
        await service.refundEnrichment({ locationId: "loc_1", contactId: "ct_1" })
      ).toBeNull();
    });
  });

  describe("grantCredits", () => {
    it("grants via the ledger, defaulting the reason to manual_grant", async () => {
      store.grant.mockResolvedValue(ledgerRow({ amount: 100, reason: "manual_grant" }));
      await service.grantCredits("loc_1", 100);
      expect(store.grant).toHaveBeenCalledWith({
        locationId: "loc_1",
        amount: 100,
        reason: "manual_grant",
      });
    });
  });

  describe("getAccountSummary", () => {
    it("returns the balance and recent ledger for a location", async () => {
      store.getBalance.mockResolvedValue(8);
      const recent = [ledgerRow()];
      store.recentEntries.mockResolvedValue(recent);

      const summary = await service.getAccountSummary("loc_1");

      expect(summary).toEqual({ locationId: "loc_1", balance: 8, recent });
    });
  });
});
