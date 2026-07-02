import { mock, MockProxy } from "jest-mock-extended";
import { PostgresDatabase } from "../../../data/PostgresDatabase";
import { GhlCustomFieldStore } from "../GhlCustomFieldStore";

/** The SQL + params of the most recent db.query call. */
const lastCall = (db: MockProxy<PostgresDatabase>): [string, unknown[]] => {
  const call = db.query.mock.calls[db.query.mock.calls.length - 1];
  return [String(call[0]), (call[1] ?? []) as unknown[]];
};

describe("GhlCustomFieldStore", () => {
  let db: MockProxy<PostgresDatabase>;
  let store: GhlCustomFieldStore;

  beforeEach(() => {
    db = mock<PostgresDatabase>();
    db.query.mockResolvedValue({ rows: [] } as never);
    store = new GhlCustomFieldStore(db);
  });

  describe("listByLocation", () => {
    it("excludes soft-deleted rows and scopes to the location", async () => {
      await store.listByLocation("loc_1");
      const [sql, params] = lastCall(db);
      expect(sql).toContain("WHERE location_id = $1 AND deleted_at IS NULL");
      expect(params).toEqual(["loc_1"]);
    });
  });

  describe("countByLocationForAll", () => {
    it("counts non-deleted fields grouped by location and coerces to numbers", async () => {
      db.query.mockResolvedValue({
        rows: [
          { location_id: "loc_1", count: "7" },
          { location_id: "loc_2", count: "3" },
        ],
      } as never);
      const counts = await store.countByLocationForAll();
      const [sql] = lastCall(db);
      expect(sql).toContain("WHERE deleted_at IS NULL");
      expect(sql).toContain("GROUP BY location_id");
      expect(counts).toEqual([
        { location_id: "loc_1", count: 7 },
        { location_id: "loc_2", count: 3 },
      ]);
    });
  });
});
