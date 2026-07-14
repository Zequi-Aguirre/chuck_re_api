import * as fs from "fs";
import * as path from "path";
import { Pool } from "pg";
import { PostgresDatabase } from "../../../data/PostgresDatabase";
import { AppSettingsStore } from "../../../data/AppSettingsStore";
import { CreditLedgerStore } from "../CreditLedgerStore";
import { CreditService } from "../CreditService";
import { CreditSettingsService } from "../CreditSettingsService";
import { MonthlyCreditRestoreService } from "../MonthlyCreditRestoreService";
import { TextJakeCustomerStore } from "../../customers/TextJakeCustomerStore";
import { GhlConnectionStore } from "../../connections/GhlConnectionStore";
import { GhlEnrichmentConfig } from "../../config/GhlEnrichmentConfig";
import {
  EphemeralPostgres,
  startEphemeralPostgres,
} from "../../../testSupport/ephemeralPostgres";

/**
 * JAK-monthly-credit-restore — REAL-Postgres integration test for the monthly
 * restore sweep. A mock DB can't prove the atomic due-claim advances
 * `next_reset_at` by exactly one month, that the guard makes a re-run a no-op, or
 * that the migration BACKFILLS existing customers correctly — those all live in
 * SQL. This runs the production migration chain against a throwaway Postgres and
 * pins:
 *   - the migration backfills existing customers to their next FUTURE signup
 *     anniversary (nobody is due on the first run);
 *   - a due customer's three buckets are RESET to the effective admin default
 *     (50 / 10 / 10) — topped up when spent AND drawn down when over-granted —
 *     and their `next_reset_at` advances EXACTLY one month;
 *   - a not-yet-due customer is untouched;
 *   - running the sweep twice does NOT double-restore (no extra ledger rows).
 */

const MIGRATIONS = path.resolve(__dirname, "../../../../../..", "postgres", "migrations");
const THIS_MIGRATION = "20260707160000.do._jak_monthly_credit_restore.sql";

/** All production migration files, oldest-first by their 14-digit timestamp prefix. */
const allMigrations = (): string[] =>
  fs
    .readdirSync(MIGRATIONS)
    .filter((f) => /^\d{14}\.do\._.+\.sql$/.test(f))
    .sort();

const readMigration = (file: string) => fs.readFileSync(path.join(MIGRATIONS, file), "utf8");

/** Adapt a raw pool to the surface the stores use (`query` + `connect`). */
const asDb = (pool: Pool): PostgresDatabase =>
  ({
    query: (text: string, params?: unknown[]) => pool.query(text, params),
    connect: () => pool.connect(),
  } as unknown as PostgresDatabase);

/** Insert a customer row directly (bypassing the store) with a controlled clock. */
async function insertCustomer(
  pool: Pool,
  id: string,
  phone: string,
  opts: { createdAt?: string; nextResetAt?: string } = {}
): Promise<void> {
  const cols = ["id", "phone"];
  const vals: unknown[] = [id, phone];
  if (opts.createdAt) {
    cols.push("created_at");
    vals.push(opts.createdAt);
  }
  if (opts.nextResetAt) {
    cols.push("next_reset_at");
    vals.push(opts.nextResetAt);
  }
  const placeholders = vals.map((_, i) => `$${i + 1}`).join(", ");
  await pool.query(
    `INSERT INTO text_jake_customers (${cols.join(", ")}) VALUES (${placeholders})`,
    vals
  );
}

/** Seed a bucket balance directly so a customer starts spent-down / over-granted. */
async function seedBalance(pool: Pool, id: string, type: string, balance: number): Promise<void> {
  await pool.query(
    `INSERT INTO credit_balances (location_id, credit_type, balance) VALUES ($1, $2, $3)
     ON CONFLICT (location_id, credit_type) DO UPDATE SET balance = EXCLUDED.balance`,
    [id, type, balance]
  );
}

const ledgerCount = async (pool: Pool, id: string): Promise<number> => {
  const r = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM credit_ledger WHERE location_id = $1`,
    [id]
  );
  return Number(r.rows[0].n);
};

describe("Monthly credit restore (real Postgres integration) — JAK-monthly-credit-restore", () => {
  jest.setTimeout(60_000); // initdb + first boot can take a few seconds.

  let pg: EphemeralPostgres;
  let pool: Pool;
  let store: TextJakeCustomerStore;
  let credits: CreditService;
  let service: MonthlyCreditRestoreService;

  // Existing (pre-migration) customers, for the backfill assertions.
  const BACKFILL_RECENT = "aaaaaaaa-0000-0000-0000-000000000001"; // created 5 days ago
  const BACKFILL_OLD = "aaaaaaaa-0000-0000-0000-000000000002"; // created 14 months ago

  beforeAll(async () => {
    pg = await startEphemeralPostgres();
    pool = pg.pool;
    // Pin the session timezone so month arithmetic on timestamptz is deterministic
    // regardless of the host/CI box's local zone.
    await pool.query(`ALTER DATABASE postgres SET timezone TO 'UTC'`);
    await pool.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);

    // 1) Apply every migration STRICTLY BEFORE this one — the pre-restore schema.
    for (const file of allMigrations().filter((f) => f < THIS_MIGRATION)) {
      await pool.query(readMigration(file));
    }

    // 2) Seed EXISTING customers (no next_reset_at column yet) with controlled
    //    signup dates: one recent, one well over a year old. created_at is a SQL
    //    interval expression, so set it directly rather than through a bound param.
    await insertCustomer(pool, BACKFILL_RECENT, "+15550000101");
    await insertCustomer(pool, BACKFILL_OLD, "+15550000102");
    await pool.query(
      `UPDATE text_jake_customers SET created_at = now() - interval '5 days' WHERE id = $1`,
      [BACKFILL_RECENT]
    );
    await pool.query(
      `UPDATE text_jake_customers SET created_at = now() - interval '14 months' WHERE id = $1`,
      [BACKFILL_OLD]
    );

    // 3) Apply THIS migration — twice, to prove the backfill + column changes are
    //    idempotent (a re-run must NOT re-backfill an already-set next_reset_at).
    await pool.query(readMigration(THIS_MIGRATION));
    await pool.query(readMigration(THIS_MIGRATION));

    // 4) Apply anything AFTER this migration (none today, but stay future-proof).
    for (const file of allMigrations().filter((f) => f > THIS_MIGRATION)) {
      await pool.query(readMigration(file));
    }

    // 5) Real stores + services over the throwaway pool. resetToDefaults only needs
    //    the ledger + the app_settings-backed defaults; the enrichment config is
    //    unused on that path, so a bare stub is fine.
    store = new TextJakeCustomerStore(asDb(pool));
    const ledger = new CreditLedgerStore(asDb(pool));
    const settings = new CreditSettingsService(new AppSettingsStore(asDb(pool)));
    credits = new CreditService(
      ledger,
      {} as unknown as GhlEnrichmentConfig,
      settings,
      new GhlConnectionStore(asDb(pool))
    );
    service = new MonthlyCreditRestoreService(store, credits);
  });

  afterAll(async () => {
    await pg.stop();
  });

  it("backfills existing customers to their next FUTURE anniversary (no first-run flood)", async () => {
    // Both existing customers must be scheduled STRICTLY in the future, within a
    // month, on their signup day-of-month — so the very first sweep resets nobody.
    const check = await pool.query<{
      id: string;
      strictly_future: boolean;
      within_a_month: boolean;
      same_day_of_month: boolean;
    }>(
      `SELECT id,
              next_reset_at > now()                                   AS strictly_future,
              next_reset_at <= now() + interval '1 month'             AS within_a_month,
              date_part('day', next_reset_at) = date_part('day', created_at) AS same_day_of_month
       FROM text_jake_customers
       WHERE id = ANY($1::uuid[])
       ORDER BY id`,
      [[BACKFILL_RECENT, BACKFILL_OLD]]
    );
    for (const row of check.rows) {
      expect(row.strictly_future).toBe(true);
      expect(row.within_a_month).toBe(true);
      expect(row.same_day_of_month).toBe(true);
    }

    // Nobody is due right now → an immediate sweep is a clean no-op.
    const summary = await service.restoreDue(new Date());
    expect(summary.restored).toBe(0);
  });

  it("resets a due customer's THREE buckets to the effective default and advances one month", async () => {
    const DUE = "bbbbbbbb-0000-0000-0000-000000000001";
    // Due as of asOf: next_reset was 2026-06-15; asOf is 5 days later.
    await insertCustomer(pool, DUE, "+15550000201", { nextResetAt: "2026-06-15 00:00:00+00" });
    // Start off-default in every bucket: report SPENT DOWN, skiptrace EMPTY, comps
    // OVER-granted — the restore must top up AND draw down to land exactly on default.
    await seedBalance(pool, DUE, "report", 3);
    await seedBalance(pool, DUE, "skiptrace", 0);
    await seedBalance(pool, DUE, "comps", 25);

    const asOf = new Date("2026-06-20T00:00:00Z");
    const summary = await service.restoreDue(asOf);

    expect(summary.accountIds).toContain(DUE);
    expect(await credits.getBalances(DUE)).toEqual({ report: 50, skiptrace: 10, comps: 10 });

    // Advanced by EXACTLY one month, staying on the signup day-of-month.
    const advanced = await pool.query<{ eq: boolean }>(
      `SELECT next_reset_at = '2026-07-15 00:00:00+00'::timestamptz AS eq
       FROM text_jake_customers WHERE id = $1`,
      [DUE]
    );
    expect(advanced.rows[0].eq).toBe(true);
  });

  it("leaves a not-yet-due customer completely untouched", async () => {
    const FUTURE = "cccccccc-0000-0000-0000-000000000001";
    await insertCustomer(pool, FUTURE, "+15550000301", { nextResetAt: "2026-07-15 00:00:00+00" });
    await seedBalance(pool, FUTURE, "report", 3);
    const before = await ledgerCount(pool, FUTURE);

    // asOf is BEFORE this customer's next_reset_at.
    await service.restoreDue(new Date("2026-06-20T00:00:00Z"));

    expect(await credits.getBalance(FUTURE, "report")).toBe(3); // not restored
    expect(await ledgerCount(pool, FUTURE)).toBe(before); // no ledger churn
    const stillFuture = await pool.query<{ eq: boolean }>(
      `SELECT next_reset_at = '2026-07-15 00:00:00+00'::timestamptz AS eq
       FROM text_jake_customers WHERE id = $1`,
      [FUTURE]
    );
    expect(stillFuture.rows[0].eq).toBe(true); // clock unchanged
  });

  it("does not double-restore when the sweep runs twice in a row", async () => {
    const TWICE = "dddddddd-0000-0000-0000-000000000001";
    await insertCustomer(pool, TWICE, "+15550000401", { nextResetAt: "2026-06-15 00:00:00+00" });
    await seedBalance(pool, TWICE, "report", 3);

    const asOf = new Date("2026-06-20T00:00:00Z");
    const first = await service.restoreDue(asOf);
    expect(first.accountIds).toContain(TWICE);
    const afterFirst = await ledgerCount(pool, TWICE);
    expect(await credits.getBalance(TWICE, "report")).toBe(50);

    // Second sweep at the SAME asOf: the guard already advanced next_reset_at past
    // asOf, so this customer is no longer due — no reset, no new ledger rows.
    const second = await service.restoreDue(asOf);
    expect(second.accountIds).not.toContain(TWICE);
    expect(await ledgerCount(pool, TWICE)).toBe(afterFirst);
    expect(await credits.getBalance(TWICE, "report")).toBe(50);
  });
});
