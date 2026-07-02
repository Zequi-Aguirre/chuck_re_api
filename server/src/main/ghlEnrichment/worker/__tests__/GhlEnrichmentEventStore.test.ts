import { mock, MockProxy } from "jest-mock-extended";
import { PostgresDatabase } from "../../../data/PostgresDatabase";
import { GhlEnrichmentEventStore } from "../GhlEnrichmentEventStore";

/** The SQL + params of the most recent db.query call. */
const lastCall = (db: MockProxy<PostgresDatabase>): [string, unknown[]] => {
  const call = db.query.mock.calls[db.query.mock.calls.length - 1];
  return [String(call[0]), (call[1] ?? []) as unknown[]];
};

describe("GhlEnrichmentEventStore", () => {
  let db: MockProxy<PostgresDatabase>;
  let store: GhlEnrichmentEventStore;

  beforeEach(() => {
    db = mock<PostgresDatabase>();
    db.query.mockResolvedValue({ rows: [{ id: "evt-1" }] } as never);
    store = new GhlEnrichmentEventStore(db);
  });

  describe("record", () => {
    it("stamps enriched_at (not failed_at) and persists attempt_count for enriched", async () => {
      await store.record({
        location_id: "loc_1",
        contact_id: "ct_1",
        status: "enriched",
        cost_estimate: 1,
        attempt_count: 2,
      });
      const [sql, params] = lastCall(db);
      // enriched_at = now(), failed_at = null.
      expect(sql).toMatch(/enriched_at[\s\S]*failed_at/);
      expect(params).toEqual(["loc_1", "ct_1", "enriched", null, 1, 2]);
    });

    it("stamps failed_at for a failed attempt", async () => {
      await store.record({
        location_id: "loc_1",
        contact_id: "ct_1",
        status: "failed",
        detail: "write-back: GHL 500",
        attempt_count: 3,
      });
      const [, params] = lastCall(db);
      expect(params).toEqual(["loc_1", "ct_1", "failed", "write-back: GHL 500", null, 3]);
    });

    it("defaults attempt_count to 0 when unspecified", async () => {
      await store.record({ location_id: "loc_1", contact_id: "ct_1", status: "skipped" });
      const [, params] = lastCall(db);
      expect(params[5]).toBe(0);
    });
  });

  describe("markDeadLetter", () => {
    it("upserts the terminal dead_letter state, guarding against clobbering enriched", async () => {
      const row = await store.markDeadLetter("loc_1", "ct_1", "load contact: GHL 500");
      const [sql, params] = lastCall(db);
      expect(sql).toContain("'dead_letter'");
      expect(sql).toContain("status <> 'enriched'");
      expect(params).toEqual(["loc_1", "ct_1", "load contact: GHL 500"]);
      expect(row).toEqual({ id: "evt-1" });
    });

    it("returns null when the guard skips the update (already enriched)", async () => {
      db.query.mockResolvedValue({ rows: [] } as never);
      expect(await store.markDeadLetter("loc_1", "ct_1", "x")).toBeNull();
    });
  });

  describe("listByStatus", () => {
    it("queries a location's records in the given statuses, newest-touched first", async () => {
      db.query.mockResolvedValue({ rows: [] } as never);
      await store.listByStatus("loc_1", ["failed", "dead_letter"], 25);
      const [sql, params] = lastCall(db);
      expect(sql).toContain("status = ANY($2)");
      expect(sql).toContain("ORDER BY modified_at DESC");
      expect(params).toEqual(["loc_1", ["failed", "dead_letter"], 25]);
    });
  });
});
