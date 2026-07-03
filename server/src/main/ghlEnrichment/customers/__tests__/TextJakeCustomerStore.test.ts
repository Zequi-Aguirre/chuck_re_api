import { mock, MockProxy } from "jest-mock-extended";
import { PostgresDatabase } from "../../../data/PostgresDatabase";
import { TextJakeCustomerRow, TextJakeCustomerStore } from "../TextJakeCustomerStore";

const row = (over: Partial<TextJakeCustomerRow> = {}): TextJakeCustomerRow => ({
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

describe("TextJakeCustomerStore profile create/update (JAK-146)", () => {
  let db: MockProxy<PostgresDatabase>;
  let store: TextJakeCustomerStore;

  beforeEach(() => {
    db = mock<PostgresDatabase>();
    store = new TextJakeCustomerStore(db);
  });

  it("create inserts phone + profile and returns the row", async () => {
    const created = row({ first_name: "Ada", last_name: "Lovelace", email: "ada@example.com" });
    (db.query as jest.Mock).mockResolvedValue({ rows: [created] });

    const result = await store.create("+17865274077", {
      firstName: "Ada",
      lastName: "Lovelace",
      email: "ada@example.com",
    });

    expect(result).toEqual(created);
    const [sql, params] = (db.query as jest.Mock).mock.calls[0];
    expect(String(sql)).toContain("INSERT INTO text_jake_customers");
    expect(params).toEqual(["+17865274077", "Ada", "Lovelace", "ada@example.com"]);
  });

  it("updateProfile updates by id, only for a live row, and returns it", async () => {
    const updated = row({ first_name: "Grace", email: null });
    (db.query as jest.Mock).mockResolvedValue({ rows: [updated] });

    const result = await store.updateProfile("cust-1", "+17865274077", {
      firstName: "Grace",
      lastName: null,
      email: null,
    });

    expect(result).toEqual(updated);
    const [sql, params] = (db.query as jest.Mock).mock.calls[0];
    expect(String(sql)).toContain("UPDATE text_jake_customers");
    expect(String(sql)).toContain("deleted_at IS NULL");
    expect(params).toEqual(["cust-1", "+17865274077", "Grace", null, null]);
  });

  it("updateProfile returns null when no live customer matches the id", async () => {
    (db.query as jest.Mock).mockResolvedValue({ rows: [] });
    const result = await store.updateProfile("nope", "+17865274077", {
      firstName: null,
      lastName: null,
      email: null,
    });
    expect(result).toBeNull();
  });
});

describe("TextJakeCustomerStore.setStatus (JAK-148)", () => {
  let db: MockProxy<PostgresDatabase>;
  let store: TextJakeCustomerStore;

  beforeEach(() => {
    db = mock<PostgresDatabase>();
    store = new TextJakeCustomerStore(db);
  });

  it("updates ONLY status (+ modified_at) for a live row and returns it", async () => {
    const held = row({ status: "on_hold" });
    (db.query as jest.Mock).mockResolvedValue({ rows: [held] });

    const result = await store.setStatus("cust-1", "on_hold");

    expect(result).toEqual(held);
    const [sql, params] = (db.query as jest.Mock).mock.calls[0];
    // The write never touches the credit ledger — status column only.
    expect(String(sql)).toContain("SET status = $2");
    expect(String(sql)).not.toMatch(/credit|balance|ledger/i);
    expect(String(sql)).toContain("deleted_at IS NULL");
    expect(params).toEqual(["cust-1", "on_hold"]);
  });

  it("returns null when no live customer matches the id", async () => {
    (db.query as jest.Mock).mockResolvedValue({ rows: [] });
    const result = await store.setStatus("nope", "deactivated");
    expect(result).toBeNull();
  });
});
