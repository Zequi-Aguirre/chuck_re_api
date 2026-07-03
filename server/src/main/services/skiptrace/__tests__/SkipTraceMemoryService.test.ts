import { mock, MockProxy } from "jest-mock-extended";
import { SkipTraceMemoryService } from "../SkipTraceMemoryService";
import { SkipTraceStore } from "../SkipTraceStore";
import { SkipTracePendingRow, SkipTraceRow } from "../SkipTraceTypes";
import { ConversationSettingsService } from "../../../ghlEnrichment/conversation/ConversationSettingsService";

/**
 * JAK-136 — the skip-trace cache free-reserve boundary + the pending-offer TTL.
 * Both are owned here (not in the SQL store) so they're testable without the wall
 * clock. The free window REUSES the JAK-134 `free_reserve_window_days` knob.
 */
describe("SkipTraceMemoryService (JAK-136)", () => {
  let store: MockProxy<SkipTraceStore>;
  let settings: MockProxy<ConversationSettingsService>;

  const DAY = 86_400_000;
  const NOW = new Date("2026-07-10T00:00:00Z").getTime();

  class Clocked extends SkipTraceMemoryService {
    protected clock(): number {
      return NOW;
    }
  }

  const traceRow = (fetchedAt: Date): SkipTraceRow => ({
    id: "st_1",
    customer_id: "cust_x",
    phone: "+15559990000",
    message_id: null,
    normalized_target: "742 Evergreen Terrace",
    target_key: "742 evergreen terrace",
    trace_record: { match: true },
    report_text: "Owner: Homer\n\nGet more property info\nGoTextJake.com",
    fetched_at: fetchedAt,
    created_at: fetchedAt,
  });

  const pending = (createdAt: Date): SkipTracePendingRow => ({
    phone: "+15559990000",
    customer_id: "cust_x",
    target: "742 Evergreen Terrace",
    credits: 3,
    created_at: createdAt,
  });

  beforeEach(() => {
    store = mock<SkipTraceStore>();
    settings = mock<ConversationSettingsService>();
    settings.freeReserveWindowDays.mockResolvedValue(5);
  });

  const svc = () => new Clocked(store, settings);

  describe("checkCache (free re-serve window)", () => {
    it("returns null when the phone never traced this target", async () => {
      store.latestTrace.mockResolvedValue(null);
      expect(await svc().checkCache("+15559990000", "742 Evergreen Terrace")).toBeNull();
    });

    it("re-serves a snapshot fetched INSIDE the free window", async () => {
      store.latestTrace.mockResolvedValue(traceRow(new Date(NOW - 2 * DAY)));
      const hit = await svc().checkCache("+15559990000", "742 Evergreen Terrace");
      expect(hit).not.toBeNull();
    });

    it("treats a snapshot exactly the window old (or older) as stale (exclusive boundary)", async () => {
      store.latestTrace.mockResolvedValue(traceRow(new Date(NOW - 5 * DAY)));
      expect(await svc().checkCache("+15559990000", "742 Evergreen Terrace")).toBeNull();
    });

    it("keys the store lookup on the canonical (lower-cased) target key", async () => {
      store.latestTrace.mockResolvedValue(null);
      await svc().checkCache("+15559990000", "  742 Evergreen   Terrace ");
      expect(store.latestTrace).toHaveBeenCalledWith("+15559990000", "742 evergreen terrace");
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
      expect(p?.target).toBe("742 Evergreen Terrace");
    });

    it("drops (and clears) an offer aged past the TTL", async () => {
      store.getPending.mockResolvedValue(
        pending(new Date(NOW - SkipTraceMemoryService.PENDING_TTL_MS - 1))
      );
      expect(await svc().freshPending("+15559990000")).toBeNull();
      expect(store.clearPending).toHaveBeenCalledWith("+15559990000");
    });
  });
});
