import * as fs from "fs";
import * as path from "path";
import { Pool } from "pg";
import { PostgresDatabase } from "../../../data/PostgresDatabase";
import { CreditLedgerStore } from "../CreditLedgerStore";
import {
  EphemeralPostgres,
  startEphemeralPostgres,
} from "../../../testSupport/ephemeralPostgres";

/**
 * JAK-161 — REAL-Postgres integration test for the three-bucket credit split.
 *
 * A mock DB can't prove a migration runs clean from v0, that the primary-key swap
 * on `credit_balances` actually takes, or that the per-bucket isolation holds at
 * the SQL level. This test runs the ENTIRE production migration chain UP TO (but
 * not including) the JAK-161 migration against a throwaway Postgres, seeds a
 * realistic PRE-split state (a legacy text customer with a single balance, plus a
 * GHL-location balance), then applies the JAK-161 migration and pins:
 *
 *   - every pre-existing balance rolled into the REPORT bucket untouched;
 *   - each existing customer was granted the new 10 skip-trace + 10 comps defaults
 *     (with matching audit ledger rows);
 *   - the new-customer default + out-of-credits-message app_settings are seeded;
 *   - re-running the migration is idempotent (no double-grant, no error);
 *   - {@link CreditLedgerStore} charges/grants/seeds each bucket INDEPENDENTLY.
 */

const MIGRATIONS = path.resolve(__dirname, "../../../../../..", "postgres", "migrations");
const THIS_MIGRATION = "20260706115941.do._jak161_split_credit_buckets.sql";

/** All production migration files, oldest-first by their 14-digit timestamp prefix. */
const allMigrations = (): string[] =>
  fs
    .readdirSync(MIGRATIONS)
    .filter((f) => /^\d{14}\.do\._.+\.sql$/.test(f))
    .sort();

const readMigration = (file: string) => fs.readFileSync(path.join(MIGRATIONS, file), "utf8");

/** Adapt a raw pool to the surface CreditLedgerStore uses (`query` + `connect`). */
const asDb = (pool: Pool): PostgresDatabase =>
  ({
    query: (text: string, params?: unknown[]) => pool.query(text, params),
    connect: () => pool.connect(),
  } as unknown as PostgresDatabase);

describe("Credit buckets (real Postgres integration) — JAK-161", () => {
  jest.setTimeout(60_000); // initdb + first boot can take a few seconds.

  let pg: EphemeralPostgres;
  let pool: Pool;
  let store: CreditLedgerStore;

  const LEGACY_CUST = "11111111-1111-1111-1111-111111111111";
  const GHL_LOC = "loc_ghl_legacy";

  beforeAll(async () => {
    pg = await startEphemeralPostgres();
    pool = pg.pool;
    await pool.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);

    // Apply the full production chain EXCEPT the JAK-161 migration — i.e. the exact
    // pre-split schema. (JAK-161 is newest, so "everything before it" is everything.)
    for (const file of allMigrations().filter((f) => f !== THIS_MIGRATION)) {
      await pool.query(readMigration(file));
    }

    // Seed a realistic PRE-split state: a legacy customer with a SINGLE balance +
    // some ledger history, and a GHL-location balance (single-pool, as it always was).
    await pool.query(
      `INSERT INTO text_jake_customers (id, phone) VALUES ($1, $2)`,
      [LEGACY_CUST, "+15550000001"]
    );
    await pool.query(`INSERT INTO credit_balances (location_id, balance) VALUES ($1, 40)`, [LEGACY_CUST]);
    await pool.query(
      `INSERT INTO credit_ledger (location_id, amount, balance_after, reason)
       VALUES ($1, 40, 40, 'manual_grant'), ($1, -1, 39, 'text_lookup')`,
      [LEGACY_CUST]
    );
    await pool.query(`INSERT INTO credit_balances (location_id, balance) VALUES ($1, 7)`, [GHL_LOC]);

    // Now apply the JAK-161 migration — twice, to prove idempotency in one pass.
    await pool.query(readMigration(THIS_MIGRATION));
    await pool.query(readMigration(THIS_MIGRATION));

    store = new CreditLedgerStore(asDb(pool));
  });

  afterAll(async () => {
    await pg.stop();
  });

  it("adds credit_type and swaps credit_balances to a composite (location_id, credit_type) PK", async () => {
    const cols = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.columns
       WHERE column_name = 'credit_type' AND table_name IN ('credit_ledger', 'credit_balances')
       ORDER BY table_name`
    );
    expect(cols.rows.map((r) => r.table_name)).toEqual(["credit_balances", "credit_ledger"]);

    const pk = await pool.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
       WHERE conname = 'credit_balances_pkey'`
    );
    expect(pk.rows[0].def).toBe("PRIMARY KEY (location_id, credit_type)");
  });

  it("rolls every pre-existing balance into the REPORT bucket, untouched", async () => {
    expect(await store.getBalance(LEGACY_CUST, "report")).toBe(40);
    expect(await store.getBalance(GHL_LOC, "report")).toBe(7);
    // The legacy ledger rows are now tagged as report history.
    const tagged = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM credit_ledger WHERE location_id = $1 AND credit_type = 'report'`,
      [LEGACY_CUST]
    );
    expect(Number(tagged.rows[0].n)).toBe(2);
  });

  it("grants existing customers the new 10 skip-trace + 10 comps defaults, once (idempotent)", async () => {
    // Ran the migration twice above — balances are 10, NOT 20.
    expect(await store.getBalance(LEGACY_CUST, "skiptrace")).toBe(10);
    expect(await store.getBalance(LEGACY_CUST, "comps")).toBe(10);

    // Exactly one audit grant row per new bucket, despite the double-apply.
    const grants = await pool.query<{ credit_type: string; n: string }>(
      `SELECT credit_type, count(*)::text AS n FROM credit_ledger
       WHERE location_id = $1 AND credit_type IN ('skiptrace', 'comps')
       GROUP BY credit_type ORDER BY credit_type`,
      [LEGACY_CUST]
    );
    expect(grants.rows).toEqual([
      { credit_type: "comps", n: "1" },
      { credit_type: "skiptrace", n: "1" },
    ]);

    // A GHL location is NOT a text customer, so it gets no skip/comps buckets.
    expect(await store.getBalance(GHL_LOC, "skiptrace")).toBe(0);
  });

  it("seeds the admin-editable new-customer defaults + out-of-credits messages", async () => {
    const settings = await pool.query<{ key: string; value: string }>(
      `SELECT key, value FROM app_settings WHERE key LIKE 'default_%_credits' OR key LIKE 'out_of_credits_message_%'
       ORDER BY key`
    );
    const byKey = Object.fromEntries(settings.rows.map((r) => [r.key, r.value]));
    expect(byKey["default_report_credits"]).toBe("100");
    expect(byKey["default_skiptrace_credits"]).toBe("10");
    expect(byKey["default_comps_credits"]).toBe("10");
    expect(byKey["out_of_credits_message_comps"]).toContain("comps");
    // Emoji-free + footer-free (the sender appends the JAK-158 footer).
    for (const key of ["report", "skiptrace", "comps"]) {
      expect(byKey[`out_of_credits_message_${key}`]).not.toContain("GoTextJake.com");
    }
  });

  it("charges, grants, and reads each bucket INDEPENDENTLY (isolation)", async () => {
    const acct = "22222222-2222-2222-2222-222222222222";
    await pool.query(`INSERT INTO text_jake_customers (id, phone) VALUES ($1, $2)`, [acct, "+15550000002"]);

    // Seed the three buckets like a new customer would be seeded.
    expect(await store.seedInitialBalance({ locationId: acct, creditType: "report", amount: 100, reason: "manual_grant" })).toBe(true);
    await store.seedInitialBalance({ locationId: acct, creditType: "skiptrace", amount: 10, reason: "manual_grant" });
    await store.seedInitialBalance({ locationId: acct, creditType: "comps", amount: 10, reason: "manual_grant" });
    // Re-seeding is a no-op (idempotent), even at a different amount.
    expect(await store.seedInitialBalance({ locationId: acct, creditType: "comps", amount: 999, reason: "manual_grant" })).toBe(false);
    expect(await store.getBalance(acct, "comps")).toBe(10);

    // Draining comps does NOT touch report or skiptrace.
    const c1 = await store.charge({ locationId: acct, creditType: "comps", lines: [{ reason: "comps", amount: 10 }] });
    expect(c1.ok).toBe(true);
    expect(await store.getBalance(acct, "comps")).toBe(0);
    expect(await store.getBalance(acct, "report")).toBe(100);
    expect(await store.getBalance(acct, "skiptrace")).toBe(10);

    // With comps empty, a further comps charge is refused — report/skiptrace still fine.
    const c2 = await store.charge({ locationId: acct, creditType: "comps", lines: [{ reason: "comps", amount: 3 }] });
    expect(c2.ok).toBe(false);
    const rpt = await store.charge({ locationId: acct, creditType: "report", lines: [{ reason: "text_lookup", amount: 1 }] });
    expect(rpt.ok).toBe(true);
    expect(await store.getBalance(acct, "report")).toBe(99);

    // A grant lands only in its own bucket.
    await store.grant({ locationId: acct, creditType: "skiptrace", amount: 5, reason: "manual_grant" });
    expect(await store.getBalance(acct, "skiptrace")).toBe(15);
    expect(await store.getBalance(acct, "comps")).toBe(0);

    // listBalances defaults to the report bucket only (the overview's primary balance).
    const reportBalances = await store.listBalances();
    const forAcct = reportBalances.find((b) => b.location_id === acct);
    expect(forAcct?.balance).toBe(99);
  });
});
