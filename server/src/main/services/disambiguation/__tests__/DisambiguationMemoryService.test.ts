import { mock, MockProxy } from "jest-mock-extended";
import { DisambiguationMemoryService } from "../DisambiguationMemoryService";
import { DisambiguationStore } from "../DisambiguationStore";
import { DisambiguationPendingRow } from "../DisambiguationTypes";

/**
 * JAK-138 — the pending disambiguation-question TTL. Owned here (not in the SQL
 * store) so a stale "which address did you mean?" question can never resolve a
 * later bare number, and so the boundary is testable without the wall clock.
 */
describe("DisambiguationMemoryService (JAK-138)", () => {
  let store: MockProxy<DisambiguationStore>;

  const NOW = new Date("2026-07-10T00:00:00Z").getTime();

  class Clocked extends DisambiguationMemoryService {
    protected clock(): number {
      return NOW;
    }
  }

  const pending = (createdAt: Date): DisambiguationPendingRow => ({
    phone: "+15559990000",
    customer_id: "cust_x",
    intent: "comps",
    comp_params: null,
    created_at: createdAt,
  });

  beforeEach(() => {
    store = mock<DisambiguationStore>();
  });

  const svc = () => new Clocked(store);

  it("returns null when there is no pending question", async () => {
    store.getPending.mockResolvedValue(null);
    expect(await svc().freshPending("+15559990000")).toBeNull();
  });

  it("returns a fresh question (created within the TTL)", async () => {
    store.getPending.mockResolvedValue(pending(new Date(NOW - 60_000)));
    const p = await svc().freshPending("+15559990000");
    expect(p?.intent).toBe("comps");
  });

  it("drops (and clears) a question aged past the TTL", async () => {
    store.getPending.mockResolvedValue(
      pending(new Date(NOW - DisambiguationMemoryService.PENDING_TTL_MS - 1))
    );
    expect(await svc().freshPending("+15559990000")).toBeNull();
    expect(store.clearPending).toHaveBeenCalledWith("+15559990000");
  });
});
