import { mock, MockProxy } from "jest-mock-extended";
import { PostgresDatabase } from "../../../data/PostgresDatabase";
import { TextJakeCustomerRow, TextJakeCustomerStore } from "../TextJakeCustomerStore";

const row = (over: Partial<TextJakeCustomerRow> = {}): TextJakeCustomerRow => ({
  id: "cust-1",
  phone: "+17865274077",
  ghl_contact_id: null,
  created_at: new Date("2026-07-01T00:00:00Z"),
  modified_at: new Date("2026-07-02T00:00:00Z"),
  deleted_at: null,
  ...over,
});

describe("TextJakeCustomerStore.listAll (JAK-129)", () => {
  let db: MockProxy<PostgresDatabase>;
  let store: TextJakeCustomerStore;

  beforeEach(() => {
    db = mock<PostgresDatabase>();
    store = new TextJakeCustomerStore(db);
  });

  it("returns every live customer, excluding soft-deleted rows", async () => {
    const rows = [row({ id: "cust-1" }), row({ id: "cust-2", phone: "+15559998888" })];
    (db.query as jest.Mock).mockResolvedValue({ rows });

    const result = await store.listAll();

    expect(result).toEqual(rows);
    const sql = String((db.query as jest.Mock).mock.calls[0][0]);
    expect(sql).toContain("deleted_at IS NULL");
  });
});
