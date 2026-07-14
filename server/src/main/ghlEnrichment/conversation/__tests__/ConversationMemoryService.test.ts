import { mock, MockProxy } from "jest-mock-extended";
import { ConversationMemoryService } from "../ConversationMemoryService";
import { ConversationSettingsService } from "../ConversationSettingsService";
import { ConversationStore } from "../ConversationStore";
import { ConversationMessageRow, LookupRow } from "../ConversationTypes";

/**
 * JAK-134 — the read/write business surface. Pins the two behaviors the assistant
 * relies on: the recent window is sized by the admin context_window_size and
 * returned chronologically, and the cache-check honors the admin
 * free_reserve_window_days with an EXCLUSIVE boundary (a snapshot exactly the
 * window's age, or older, is stale).
 */
const DAY_MS = 86_400_000;
const NOW = 1_700_000_000_000;

class TestMemory extends ConversationMemoryService {
  protected clock(): number {
    return NOW;
  }
}

const msg = (over: Partial<ConversationMessageRow> = {}): ConversationMessageRow => ({
  id: "m1",
  customer_id: "cust_1",
  phone: "+15550000000",
  direction: "inbound",
  body: "hi",
  resolved_address: null,
  tenant_location_id: null,
  text_mode: "gateway",
  created_at: new Date(NOW),
  ...over,
});

const lookup = (fetchedAtMs: number): LookupRow => ({
  id: "lk_1",
  customer_id: "cust_1",
  phone: "+15550000000",
  message_id: "m1",
  normalized_address: "1 A St, Town, CA 90000",
  address_key: "1 a st, town, ca 90000",
  order_index: 1,
  property_id: "p1",
  property_record: {},
  report_text: "report",
  fetched_at: new Date(fetchedAtMs),
  created_at: new Date(fetchedAtMs),
});

describe("ConversationMemoryService", () => {
  let store: MockProxy<ConversationStore>;
  let settings: MockProxy<ConversationSettingsService>;
  let svc: TestMemory;

  beforeEach(() => {
    store = mock<ConversationStore>();
    settings = mock<ConversationSettingsService>();
    svc = new TestMemory(store, settings);
    settings.contextWindowSize.mockResolvedValue(10);
    settings.freeReserveWindowDays.mockResolvedValue(5);
  });

  describe("recentMessages (config honored)", () => {
    it("passes the admin context_window_size to the store and returns oldest-first", async () => {
      settings.contextWindowSize.mockResolvedValue(3);
      // Store returns NEWEST-first; the service reverses to chronological.
      store.recentMessages.mockResolvedValue([
        msg({ id: "m3", body: "third" }),
        msg({ id: "m2", body: "second" }),
        msg({ id: "m1", body: "first" }),
      ]);

      const out = await svc.recentMessages("+15550000000");

      expect(store.recentMessages).toHaveBeenCalledWith("+15550000000", 3);
      expect(out.map((m) => m.body)).toEqual(["first", "second", "third"]);
    });
  });

  describe("resolvedAddressList (JAK-135)", () => {
    it("delegates to the store's ordered resolved-address query", async () => {
      store.resolvedAddresses.mockResolvedValue(["1 A St, Town, CA 90000", "2 B St, Town, CA 90000"]);
      const out = await svc.resolvedAddressList("+15550000000");
      expect(store.resolvedAddresses).toHaveBeenCalledWith("+15550000000");
      expect(out).toEqual(["1 A St, Town, CA 90000", "2 B St, Town, CA 90000"]);
    });
  });

  describe("checkCache (free-reserve window boundary)", () => {
    it("returns null when there is no snapshot for the address", async () => {
      store.latestLookup.mockResolvedValue(null);
      expect(await svc.checkCache("+15550000000", "1 A St, Town, CA 90000")).toBeNull();
    });

    it("HIT: a snapshot just inside the window is re-servable", async () => {
      store.latestLookup.mockResolvedValue(lookup(NOW - 5 * DAY_MS + 1000));
      const hit = await svc.checkCache("+15550000000", "1 A St, Town, CA 90000");
      expect(hit).not.toBeNull();
      // The cache key is canonicalized (lower-cased) before hitting the store.
      expect(store.latestLookup).toHaveBeenCalledWith("+15550000000", "1 a st, town, ca 90000");
    });

    it("MISS: a snapshot EXACTLY the window's age is stale (exclusive boundary)", async () => {
      store.latestLookup.mockResolvedValue(lookup(NOW - 5 * DAY_MS));
      expect(await svc.checkCache("+15550000000", "1 A St, Town, CA 90000")).toBeNull();
    });

    it("MISS: a snapshot older than the window is stale", async () => {
      store.latestLookup.mockResolvedValue(lookup(NOW - 5 * DAY_MS - 1000));
      expect(await svc.checkCache("+15550000000", "1 A St, Town, CA 90000")).toBeNull();
    });

    it("uses the admin free_reserve_window_days (config honored)", async () => {
      settings.freeReserveWindowDays.mockResolvedValue(1);
      // 2 days old: fresh under a 5-day window, stale under a 1-day window.
      store.latestLookup.mockResolvedValue(lookup(NOW - 2 * DAY_MS));
      expect(await svc.checkCache("+15550000000", "1 A St, Town, CA 90000")).toBeNull();
      expect(settings.freeReserveWindowDays).toHaveBeenCalled();
    });
  });

  describe("recordLookup", () => {
    it("canonicalizes the address into address_key before storing", async () => {
      store.recordLookup.mockResolvedValue(lookup(NOW));
      await svc.recordLookup({
        customerId: "cust_1",
        phone: "+15550000000",
        messageId: "m1",
        normalizedAddress: "1 A St, Town, CA 90000",
        propertyId: "p1",
        propertyRecord: { a: 1 },
        reportText: "report",
      });
      expect(store.recordLookup).toHaveBeenCalledWith(
        expect.objectContaining({ addressKey: "1 a st, town, ca 90000" })
      );
    });
  });

  describe("appendInbound / appendOutbound", () => {
    it("stamps the direction on each message", async () => {
      store.appendMessage.mockResolvedValue(msg());
      await svc.appendInbound({
        customerId: "cust_1",
        phone: "+15550000000",
        body: "1 A St",
        resolvedAddress: "1 A St",
        tenantLocationId: null,
        textMode: "gateway",
      });
      await svc.appendOutbound({
        customerId: "cust_1",
        phone: "+15550000000",
        body: "report",
        tenantLocationId: null,
        textMode: "gateway",
      });
      expect(store.appendMessage).toHaveBeenNthCalledWith(1, expect.objectContaining({ direction: "inbound" }));
      expect(store.appendMessage).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ direction: "outbound", resolvedAddress: null })
      );
    });
  });
});
