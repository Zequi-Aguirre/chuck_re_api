import { mock, MockProxy } from "jest-mock-extended";
import { PoolClient } from "pg";
import { PostgresDatabase } from "../../../data/PostgresDatabase";
import { CreditLedgerStore } from "../CreditLedgerStore";

/**
 * Route a transaction's queries by SQL substring so tests stay resilient to
 * exact SQL formatting. `FOR UPDATE` returns the locked balance; each
 * credit_ledger INSERT returns a stub row.
 */
const routeTxn = (
  client: MockProxy<PoolClient>,
  lockedBalance: number,
  outstandingNet = 0
): void => {
  let ledgerSeq = 0;
  (client.query as jest.Mock).mockImplementation(async (text: unknown) => {
    const sql = String(text);
    if (sql.includes("FOR UPDATE")) return { rows: [{ balance: lockedBalance }] };
    // The per-contact idempotency / refund probe: net signed delta already on
    // the books for the contact (negative = an unrefunded charge).
    if (sql.includes("SUM(amount)")) return { rows: [{ net: outstandingNet }] };
    if (sql.includes("INSERT INTO credit_ledger")) {
      return { rows: [{ id: `led-${++ledgerSeq}` }] };
    }
    return { rows: [] };
  });
};

/** All SQL statements run on the txn client, in order. */
const sqlSequence = (client: MockProxy<PoolClient>): string[] =>
  (client.query as jest.Mock).mock.calls.map((c) => String(c[0]));

/** The params of the first statement whose SQL includes `needle`. */
const paramsOf = (client: MockProxy<PoolClient>, needle: string): unknown[] =>
  ((client.query as jest.Mock).mock.calls.find((c) => String(c[0]).includes(needle))?.[1] ??
    []) as unknown[];

describe("CreditLedgerStore", () => {
  let db: MockProxy<PostgresDatabase>;
  let client: MockProxy<PoolClient>;
  let store: CreditLedgerStore;

  beforeEach(() => {
    db = mock<PostgresDatabase>();
    client = mock<PoolClient>();
    db.connect.mockResolvedValue(client);
    store = new CreditLedgerStore(db);
  });

  describe("getBalance", () => {
    it("returns the stored balance", async () => {
      db.query.mockResolvedValue({ rows: [{ balance: 42 }] } as never);
      expect(await store.getBalance("loc_1")).toBe(42);
    });

    it("returns 0 for a location with no balance row", async () => {
      db.query.mockResolvedValue({ rows: [] } as never);
      expect(await store.getBalance("loc_1")).toBe(0);
    });
  });

  describe("charge (atomic deduct)", () => {
    it("commits, deducts the total, and writes one ledger row per line", async () => {
      routeTxn(client, 5);

      const result = await store.charge({
        locationId: "loc_1",
        contactId: "ct_1",
        lines: [
          { reason: "enrichment", amount: 1 },
          { reason: "skip_trace", amount: 2 },
        ],
      });

      expect(result).toEqual({
        ok: true,
        balanceAfter: 2,
        entries: [{ id: "led-1" }, { id: "led-2" }],
      });

      const seq = sqlSequence(client);
      expect(seq[0]).toBe("BEGIN");
      expect(seq[seq.length - 1]).toBe("COMMIT");
      expect(seq).toEqual(expect.arrayContaining([expect.stringContaining("FOR UPDATE")]));

      // Balance updated to 5 - (1+2) = 2.
      expect(paramsOf(client, "UPDATE credit_balances")).toEqual(["loc_1", 2]);

      // Ledger rows record NEGATIVE amounts with the running balance snapshot.
      const ledgerCalls = (client.query as jest.Mock).mock.calls.filter((c) =>
        String(c[0]).includes("INSERT INTO credit_ledger")
      );
      expect(ledgerCalls[0][1]).toEqual(["loc_1", -1, 4, "enrichment", "ct_1"]);
      expect(ledgerCalls[1][1]).toEqual(["loc_1", -2, 2, "skip_trace", "ct_1"]);

      expect(client.release).toHaveBeenCalledTimes(1);
    });

    it("refuses to overdraw: rolls back and writes nothing when funds fall short", async () => {
      routeTxn(client, 1);

      const result = await store.charge({
        locationId: "loc_1",
        contactId: "ct_1",
        lines: [{ reason: "enrichment", amount: 3 }],
      });

      expect(result).toEqual({ ok: false, balance: 1, required: 3 });
      const seq = sqlSequence(client);
      expect(seq).toContain("ROLLBACK");
      expect(seq).not.toContain("COMMIT");
      expect(seq).not.toEqual(
        expect.arrayContaining([expect.stringContaining("INSERT INTO credit_ledger")])
      );
      expect(seq).not.toEqual(
        expect.arrayContaining([expect.stringContaining("UPDATE credit_balances")])
      );
      expect(client.release).toHaveBeenCalledTimes(1);
    });

    it("treats a missing balance row as 0 credits", async () => {
      (client.query as jest.Mock).mockImplementation(async (text: unknown) => {
        if (String(text).includes("FOR UPDATE")) return { rows: [] };
        return { rows: [] };
      });

      const result = await store.charge({
        locationId: "loc_new",
        contactId: "ct_1",
        lines: [{ reason: "enrichment", amount: 1 }],
      });

      expect(result).toEqual({ ok: false, balance: 0, required: 1 });
    });

    it("rolls back and releases the client if a statement throws", async () => {
      (client.query as jest.Mock).mockImplementation(async (text: unknown) => {
        const sql = String(text);
        if (sql.includes("FOR UPDATE")) return { rows: [{ balance: 10 }] };
        if (sql.includes("UPDATE credit_balances")) throw new Error("db down");
        return { rows: [] };
      });

      await expect(
        store.charge({ locationId: "loc_1", lines: [{ reason: "enrichment", amount: 1 }] })
      ).rejects.toThrow("db down");
      expect(sqlSequence(client)).toContain("ROLLBACK");
      expect(client.release).toHaveBeenCalledTimes(1);
    });
  });

  describe("charge idempotency by contact (JAK-111)", () => {
    it("is a no-op when the contact already carries an unrefunded charge", async () => {
      // Contact already net -1 on the books → a retry must NOT charge again.
      routeTxn(client, 10, -1);

      const result = await store.charge({
        locationId: "loc_1",
        contactId: "ct_1",
        lines: [{ reason: "enrichment", amount: 1 }],
      });

      expect(result).toEqual({ ok: true, balanceAfter: 10, entries: [] });
      const seq = sqlSequence(client);
      expect(seq).toContain("ROLLBACK");
      expect(seq).not.toContain("COMMIT");
      // No new debit written.
      expect(seq).not.toEqual(
        expect.arrayContaining([expect.stringContaining("INSERT INTO credit_ledger")])
      );
      expect(client.release).toHaveBeenCalledTimes(1);
    });

    it("charges normally when the contact was charged then refunded (net 0)", async () => {
      routeTxn(client, 10, 0);
      const result = await store.charge({
        locationId: "loc_1",
        contactId: "ct_1",
        lines: [{ reason: "enrichment", amount: 1 }],
      });
      expect(result.ok).toBe(true);
      expect(sqlSequence(client)).toContain("COMMIT");
    });

    it("skips the idempotency probe entirely for a contactless charge", async () => {
      routeTxn(client, 5);
      await store.charge({ locationId: "loc_1", lines: [{ reason: "enrichment", amount: 1 }] });
      expect(sqlSequence(client)).not.toEqual(
        expect.arrayContaining([expect.stringContaining("SUM(amount)")])
      );
    });
  });

  describe("refund (compensating entry, JAK-111)", () => {
    it("reverses the outstanding charge and writes one positive refund row", async () => {
      // Balance 4, contact owes a net -1 charge → refund credits it back to 5.
      routeTxn(client, 4, -1);

      const row = await store.refund({ locationId: "loc_1", contactId: "ct_1" });

      expect(row).toEqual({ id: "led-1" });
      expect(paramsOf(client, "UPDATE credit_balances")).toEqual(["loc_1", 5]);
      expect(paramsOf(client, "INSERT INTO credit_ledger")).toEqual([
        "loc_1",
        1, // positive reversal of the -1 debit
        5,
        "refund",
        "ct_1",
      ]);
      expect(sqlSequence(client)).toContain("COMMIT");
      expect(client.release).toHaveBeenCalledTimes(1);
    });

    it("is an idempotent no-op when nothing is outstanding (net >= 0)", async () => {
      routeTxn(client, 10, 0);
      const row = await store.refund({ locationId: "loc_1", contactId: "ct_1" });
      expect(row).toBeNull();
      const seq = sqlSequence(client);
      expect(seq).toContain("ROLLBACK");
      expect(seq).not.toContain("COMMIT");
      expect(seq).not.toEqual(
        expect.arrayContaining([expect.stringContaining("INSERT INTO credit_ledger")])
      );
    });

    it("rolls back and releases the client if a statement throws", async () => {
      (client.query as jest.Mock).mockImplementation(async (text: unknown) => {
        const sql = String(text);
        if (sql.includes("FOR UPDATE")) return { rows: [{ balance: 4 }] };
        if (sql.includes("SUM(amount)")) return { rows: [{ net: -1 }] };
        if (sql.includes("INSERT INTO credit_ledger")) throw new Error("db down");
        return { rows: [] };
      });
      await expect(store.refund({ locationId: "loc_1", contactId: "ct_1" })).rejects.toThrow(
        "db down"
      );
      expect(sqlSequence(client)).toContain("ROLLBACK");
      expect(client.release).toHaveBeenCalledTimes(1);
    });
  });

  describe("grant (atomic credit)", () => {
    it("commits, adds to the balance, and writes one positive ledger row", async () => {
      routeTxn(client, 2);

      const row = await store.grant({ locationId: "loc_1", amount: 5, reason: "manual_grant" });

      expect(row).toEqual({ id: "led-1" });
      expect(paramsOf(client, "UPDATE credit_balances")).toEqual(["loc_1", 7]);
      expect(paramsOf(client, "INSERT INTO credit_ledger")).toEqual([
        "loc_1",
        5,
        7,
        "manual_grant",
        null,
      ]);
      expect(sqlSequence(client)).toContain("COMMIT");
      expect(client.release).toHaveBeenCalledTimes(1);
    });

    it("rejects a non-positive grant without opening a transaction", async () => {
      await expect(
        store.grant({ locationId: "loc_1", amount: 0, reason: "manual_grant" })
      ).rejects.toThrow("positive integer");
      expect(db.connect).not.toHaveBeenCalled();
    });
  });

  describe("recentEntries", () => {
    it("queries newest-first with the given limit, excluding voided rows", async () => {
      db.query.mockResolvedValue({ rows: [] } as never);
      await store.recentEntries("loc_1", 5);
      const [sql, params] = db.query.mock.calls[0];
      expect(sql).toContain("deleted_at IS NULL");
      expect(sql).toContain("ORDER BY created_at DESC");
      expect(params).toEqual(["loc_1", 5]);
    });
  });
});
