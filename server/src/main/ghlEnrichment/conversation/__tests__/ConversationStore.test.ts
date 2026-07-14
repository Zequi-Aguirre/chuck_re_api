import { mock, MockProxy } from "jest-mock-extended";
import { PostgresDatabase } from "../../../data/PostgresDatabase";
import { ConversationStore } from "../ConversationStore";

/**
 * JAK-134 — pure-SQL persistence for conversation memory + the lookup cache.
 * These pin the SQL shape + params (resilient to formatting via substrings),
 * mirroring the CreditLedgerStore store tests.
 */
const lastQuery = (db: MockProxy<PostgresDatabase>) =>
  (db.query as jest.Mock).mock.calls[(db.query as jest.Mock).mock.calls.length - 1];

describe("ConversationStore", () => {
  let db: MockProxy<PostgresDatabase>;
  let store: ConversationStore;

  beforeEach(() => {
    db = mock<PostgresDatabase>();
    store = new ConversationStore(db);
  });

  describe("appendMessage", () => {
    it("inserts one ordered row with direction + resolved fields", async () => {
      db.query.mockResolvedValue({ rows: [{ id: "m1" }] } as never);

      await store.appendMessage({
        customerId: "cust_1",
        phone: "+15550000000",
        direction: "inbound",
        body: "1 A St, Town, CA 90000",
        resolvedAddress: "1 A St, Town, CA 90000",
        tenantLocationId: "loc_a",
        textMode: "own_number",
      });

      const [sql, params] = lastQuery(db);
      expect(String(sql)).toContain("INSERT INTO text_jake_conversation_messages");
      expect(params).toEqual([
        "cust_1",
        "+15550000000",
        "inbound",
        "1 A St, Town, CA 90000",
        "1 A St, Town, CA 90000",
        "loc_a",
        "own_number",
      ]);
    });

    it("defaults the optional fields to null", async () => {
      db.query.mockResolvedValue({ rows: [{ id: "m1" }] } as never);
      await store.appendMessage({
        customerId: "cust_1",
        phone: "+15550000000",
        direction: "outbound",
        body: "report",
      });
      const [, params] = lastQuery(db);
      expect(params).toEqual(["cust_1", "+15550000000", "outbound", "report", null, null, null]);
    });
  });

  describe("recentMessages", () => {
    it("selects newest-first, limited", async () => {
      db.query.mockResolvedValue({ rows: [] } as never);
      await store.recentMessages("+15550000000", 10);
      const [sql, params] = lastQuery(db);
      expect(String(sql)).toContain("FROM text_jake_conversation_messages");
      expect(String(sql)).toContain("ORDER BY created_at DESC, id DESC");
      expect(String(sql)).toContain("LIMIT $2");
      expect(params).toEqual(["+15550000000", 10]);
    });
  });

  describe("lastResolvedAddress", () => {
    it("returns the most recent inbound resolved address", async () => {
      db.query.mockResolvedValue({ rows: [{ resolved_address: "9 B Rd, Town, CA 90000" }] } as never);
      expect(await store.lastResolvedAddress("+15550000000")).toBe("9 B Rd, Town, CA 90000");
      const [sql] = lastQuery(db);
      expect(String(sql)).toContain("direction = 'inbound'");
      expect(String(sql)).toContain("resolved_address IS NOT NULL");
    });

    it("returns null when the phone has no resolved address yet", async () => {
      db.query.mockResolvedValue({ rows: [] } as never);
      expect(await store.lastResolvedAddress("+15550000000")).toBeNull();
    });
  });

  describe("updateResolvedAddress (JAK-166 active-property backfill)", () => {
    it("UPDATEs the resolved_address of the given message id", async () => {
      db.query.mockResolvedValue({ rows: [] } as never);
      await store.updateResolvedAddress("m1", "7680 Sunset Strip, Sunrise, FL 33322");
      const [sql, params] = lastQuery(db);
      expect(String(sql)).toContain("UPDATE text_jake_conversation_messages");
      expect(String(sql)).toContain("SET resolved_address = $2");
      expect(String(sql)).toContain("WHERE id = $1");
      expect(params).toEqual(["m1", "7680 Sunset Strip, Sunrise, FL 33322"]);
    });
  });

  describe("resolvedAddresses (JAK-135 ordered list)", () => {
    it("returns DISTINCT inbound resolved addresses, oldest-first by first send", async () => {
      db.query.mockResolvedValue({
        rows: [
          { resolved_address: "1 First St, Town, CA 90000" },
          { resolved_address: "2 Second Ave, Town, CA 90000" },
        ],
      } as never);

      const list = await store.resolvedAddresses("+15550000000");

      expect(list).toEqual(["1 First St, Town, CA 90000", "2 Second Ave, Town, CA 90000"]);
      const [sql, params] = lastQuery(db);
      expect(String(sql)).toContain("direction = 'inbound'");
      expect(String(sql)).toContain("resolved_address IS NOT NULL");
      expect(String(sql)).toContain("GROUP BY resolved_address");
      expect(String(sql)).toContain("MIN(created_at)");
      expect(params).toEqual(["+15550000000"]);
    });

    it("returns [] when the phone has sent no addresses", async () => {
      db.query.mockResolvedValue({ rows: [] } as never);
      expect(await store.resolvedAddresses("+15550000000")).toEqual([]);
    });
  });

  describe("latestLookup", () => {
    it("selects the newest snapshot for (phone, address_key)", async () => {
      db.query.mockResolvedValue({ rows: [{ id: "lk_1" }] } as never);
      const row = await store.latestLookup("+15550000000", "1 a st, town, ca 90000");
      expect(row).toEqual({ id: "lk_1" });
      const [sql, params] = lastQuery(db);
      expect(String(sql)).toContain("FROM text_jake_lookups");
      expect(String(sql)).toContain("address_key = $2");
      expect(String(sql)).toContain("ORDER BY fetched_at DESC");
      expect(params).toEqual(["+15550000000", "1 a st, town, ca 90000"]);
    });

    it("returns null when there is no snapshot", async () => {
      db.query.mockResolvedValue({ rows: [] } as never);
      expect(await store.latestLookup("+15550000000", "x")).toBeNull();
    });
  });

  describe("recordLookup", () => {
    it("assigns the next per-phone order index atomically and JSON-encodes the record", async () => {
      db.query.mockResolvedValue({ rows: [{ id: "lk_1", order_index: 2 }] } as never);

      await store.recordLookup({
        customerId: "cust_1",
        phone: "+15550000000",
        messageId: "m1",
        normalizedAddress: "1 A St, Town, CA 90000",
        addressKey: "1 a st, town, ca 90000",
        propertyId: "987",
        propertyRecord: { id: 987, address: "1 A St" },
        reportText: "Jake Property Report",
      });

      const [sql, params] = lastQuery(db);
      expect(String(sql)).toContain("INSERT INTO text_jake_lookups");
      // Order index is computed in-statement as MAX(order_index)+1 for the phone.
      expect(String(sql)).toContain("MAX(order_index)");
      expect(String(sql)).toContain("$7::jsonb");
      expect(params).toEqual([
        "cust_1",
        "+15550000000",
        "m1",
        "1 A St, Town, CA 90000",
        "1 a st, town, ca 90000",
        "987",
        JSON.stringify({ id: 987, address: "1 A St" }),
        "Jake Property Report",
      ]);
    });

    it("encodes a null property record safely", async () => {
      db.query.mockResolvedValue({ rows: [{ id: "lk_1" }] } as never);
      await store.recordLookup({
        customerId: "cust_1",
        phone: "+15550000000",
        messageId: null,
        normalizedAddress: "1 A St",
        addressKey: "1 a st",
        propertyId: null,
        propertyRecord: null,
        reportText: "r",
      });
      const [, params] = lastQuery(db);
      expect(params[2]).toBeNull(); // messageId
      expect(params[5]).toBeNull(); // propertyId
      expect(params[6]).toBe("null"); // JSON.stringify(null)
    });
  });
});
