import { mock, MockProxy } from "jest-mock-extended";
import { CompsMemoryService } from "../CompsMemoryService";
import { CompsStore } from "../CompsStore";
import { CompsPendingRow, CompsRow, DEFAULT_COMP_PARAMS, compsCacheKey } from "../CompsTypes";
import { ConversationSettingsService } from "../../../ghlEnrichment/conversation/ConversationSettingsService";

/**
 * JAK-137 — the comps cache free-reserve boundary + the pending-offer TTL. Both are
 * owned here (not in the SQL store) so they're testable without the wall clock. The
 * free window REUSES the JAK-134 `free_reserve_window_days` knob, and the cache key
 * folds in the parameter-set so a different search never re-serves a stale one.
 */
describe("CompsMemoryService (JAK-137)", () => {
  let store: MockProxy<CompsStore>;
  let settings: MockProxy<ConversationSettingsService>;

  const DAY = 86_400_000;
  const NOW = new Date("2026-07-10T00:00:00Z").getTime();
  const TARGET = "742 Evergreen Terrace";
  const PARAMS = DEFAULT_COMP_PARAMS;

  class Clocked extends CompsMemoryService {
    protected clock(): number {
      return NOW;
    }
  }

  const compsRow = (fetchedAt: Date): CompsRow => ({
    id: "cmp_1",
    customer_id: "cust_x",
    phone: "+15559990000",
    message_id: null,
    normalized_target: TARGET,
    target_key: compsCacheKey(TARGET, PARAMS),
    params: PARAMS,
    comps_record: { comps: [] },
    report_text: "Comparable sales\n\nGet more property info\nGoTextJake.com",
    fetched_at: fetchedAt,
    created_at: fetchedAt,
  });

  const pending = (createdAt: Date): CompsPendingRow => ({
    phone: "+15559990000",
    customer_id: "cust_x",
    target: TARGET,
    params: PARAMS,
    credits: 3,
    created_at: createdAt,
  });

  beforeEach(() => {
    store = mock<CompsStore>();
    settings = mock<ConversationSettingsService>();
    settings.freeReserveWindowDays.mockResolvedValue(5);
  });

  const svc = () => new Clocked(store, settings);

  describe("checkCache (free re-serve window, keyed by params)", () => {
    it("returns null when the phone never ran this request", async () => {
      store.latestComps.mockResolvedValue(null);
      expect(await svc().checkCache("+15559990000", TARGET, PARAMS)).toBeNull();
    });

    it("re-serves a snapshot fetched INSIDE the free window", async () => {
      store.latestComps.mockResolvedValue(compsRow(new Date(NOW - 2 * DAY)));
      expect(await svc().checkCache("+15559990000", TARGET, PARAMS)).not.toBeNull();
    });

    it("treats a snapshot exactly the window old (or older) as stale (exclusive boundary)", async () => {
      store.latestComps.mockResolvedValue(compsRow(new Date(NOW - 5 * DAY)));
      expect(await svc().checkCache("+15559990000", TARGET, PARAMS)).toBeNull();
    });

    it("keys the store lookup on the canonical address + parameter signature", async () => {
      store.latestComps.mockResolvedValue(null);
      await svc().checkCache("+15559990000", "  742 Evergreen   Terrace ", PARAMS);
      expect(store.latestComps).toHaveBeenCalledWith("+15559990000", compsCacheKey("742 Evergreen Terrace", PARAMS));
    });

    it("a different parameter-set is a different key (not a cache hit)", async () => {
      store.latestComps.mockResolvedValue(null);
      await svc().checkCache("+15559990000", TARGET, { ...PARAMS, count: 3 });
      expect(store.latestComps).toHaveBeenCalledWith(
        "+15559990000",
        compsCacheKey(TARGET, { ...PARAMS, count: 3 })
      );
      // The signature differs from the default param-set's key.
      expect(compsCacheKey(TARGET, { ...PARAMS, count: 3 })).not.toBe(compsCacheKey(TARGET, PARAMS));
    });
  });

  describe("freshPending (confirm-before-spend offer TTL)", () => {
    it("returns null when there is no pending offer", async () => {
      store.getPending.mockResolvedValue(null);
      expect(await svc().freshPending("+15559990000")).toBeNull();
    });

    it("returns a fresh offer (created within the TTL)", async () => {
      store.getPending.mockResolvedValue(pending(new Date(NOW - 60_000)));
      const p = await svc().freshPending("+15559990000");
      expect(p?.target).toBe(TARGET);
    });

    it("drops (and clears) an offer aged past the TTL", async () => {
      store.getPending.mockResolvedValue(pending(new Date(NOW - CompsMemoryService.PENDING_TTL_MS - 1)));
      expect(await svc().freshPending("+15559990000")).toBeNull();
      expect(store.clearPending).toHaveBeenCalledWith("+15559990000");
    });
  });
});
