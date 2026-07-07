import * as fs from "fs";
import * as path from "path";
import { Pool } from "pg";
import { PostgresDatabase } from "../../../data/PostgresDatabase";
import { TextJakeCustomerStore } from "../TextJakeCustomerStore";
import {
  EphemeralPostgres,
  startEphemeralPostgres,
} from "../../../testSupport/ephemeralPostgres";

/**
 * JAK-dedup-customers — REAL-Postgres integration test for the phone-dedup migration.
 *
 * A mock DB can't prove the merge SQL runs clean against the full production schema,
 * that FK-cascade children survive the duplicate's deletion, or that the UNIQUE(phone)
 * constraint actually rejects a future duplicate. This test applies the ENTIRE
 * production migration chain UP TO (but not including) the dedup migration, seeds a
 * realistic duplicate pair — a NAMED E.164 customer and an UNNAMED formatted-phone
 * duplicate, each with child rows + credits — then applies the dedup migration (twice,
 * to prove idempotency) and pins:
 *
 *   - the pair collapses to ONE row: the NAMED one, phone rewritten to canonical E.164;
 *   - EVERY child row (messages, lookups, skip traces, comps) is re-pointed to the kept
 *     customer with a canonical phone — zero child-row loss;
 *   - credits merge per bucket = SUM(kept + duplicate), ledger re-pointed (audit intact);
 *   - a per-phone pending row collision keeps the newest, re-pointed to the kept row;
 *   - a singleton with a formatted phone is canonicalized in place;
 *   - after migration, a raw INSERT of the same canonical phone is rejected (23505).
 */

const MIGRATIONS = path.resolve(__dirname, "../../../../../..", "postgres", "migrations");
const THIS_MIGRATION = "20260707130728.do._jak_dedup_customers_normalize_phone.sql";

const allMigrations = (): string[] =>
  fs
    .readdirSync(MIGRATIONS)
    .filter((f) => /^\d{14}\.do\._.+\.sql$/.test(f))
    .sort();

const readMigration = (file: string) => fs.readFileSync(path.join(MIGRATIONS, file), "utf8");

const asDb = (pool: Pool): PostgresDatabase =>
  ({
    query: (text: string, params?: unknown[]) => pool.query(text, params),
    connect: () => pool.connect(),
  } as unknown as PostgresDatabase);

describe("Customer phone dedup migration (real Postgres) — JAK-dedup-customers", () => {
  jest.setTimeout(60_000);

  let pg: EphemeralPostgres;
  let pool: Pool;

  // The NAMED, canonical-E.164 row we expect to KEEP.
  const KEEP = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  // The UNNAMED, formatted-phone DUPLICATE we expect to be merged away.
  const DUP = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
  // A lone customer whose phone is un-normalized but has no duplicate.
  const SOLO = "cccccccc-cccc-cccc-cccc-cccccccccccc";

  const CANON = "+14845076216"; // canonical form of both KEEP and DUP.
  const SOLO_CANON = "+13055551212";

  beforeAll(async () => {
    pg = await startEphemeralPostgres();
    pool = pg.pool;
    await pool.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);

    for (const file of allMigrations().filter((f) => f !== THIS_MIGRATION)) {
      await pool.query(readMigration(file));
    }

    // --- Seed the pre-dedup state -------------------------------------------------
    // KEEP: NAMED, already E.164, created LATER than DUP — proves "named wins" beats
    // "oldest wins". DUP: UNNAMED, formatted phone, created earlier.
    await pool.query(
      `INSERT INTO text_jake_customers (id, phone, first_name, last_name, email, created_at)
       VALUES ($1, $2, 'Jane', 'Doe', 'jane@example.com', '2026-01-02T00:00:00Z')`,
      [KEEP, CANON]
    );
    await pool.query(
      `INSERT INTO text_jake_customers (id, phone, created_at)
       VALUES ($1, '(484)507-6216', '2026-01-01T00:00:00Z')`,
      [DUP]
    );
    // A singleton with a formatted phone and no duplicate.
    await pool.query(
      `INSERT INTO text_jake_customers (id, phone) VALUES ($1, '(305) 555-1212')`,
      [SOLO]
    );

    // Child rows on BOTH the kept row and the duplicate — all must survive.
    for (const [cid, phone, body] of [
      [KEEP, CANON, "keep-msg"],
      [DUP, "(484)507-6216", "dup-msg-1"],
      [DUP, "(484)507-6216", "dup-msg-2"],
    ] as const) {
      await pool.query(
        `INSERT INTO text_jake_conversation_messages (customer_id, phone, direction, body)
         VALUES ($1, $2, 'inbound', $3)`,
        [cid, phone, body]
      );
    }
    await pool.query(
      `INSERT INTO text_jake_lookups
         (customer_id, phone, normalized_address, address_key, order_index, property_record, report_text)
       VALUES ($1, '(484)507-6216', '1 Main St', '1 main st', 1, '{}'::jsonb, 'r')`,
      [DUP]
    );
    await pool.query(
      `INSERT INTO text_jake_skip_traces
         (customer_id, phone, normalized_target, target_key, trace_record, report_text)
       VALUES ($1, '(484)507-6216', '1 Main St', '1 main st', '{}'::jsonb, 'r')`,
      [DUP]
    );
    await pool.query(
      `INSERT INTO text_jake_comps
         (customer_id, phone, normalized_target, target_key, params, comps_record, report_text)
       VALUES ($1, '(484)507-6216', '1 Main St', '1 main st', '{}'::jsonb, '{}'::jsonb, 'r')`,
      [DUP]
    );

    // A pending offer on EACH of KEEP and DUP — they collide on the canonical phone.
    // DUP's is newer, so it must win and be re-pointed to KEEP.
    await pool.query(
      `INSERT INTO text_jake_comps_pending (phone, customer_id, target, params, credits, created_at)
       VALUES ($1, $2, 'old', '{}'::jsonb, 3, '2026-01-01T00:00:00Z')`,
      [CANON, KEEP]
    );
    await pool.query(
      `INSERT INTO text_jake_comps_pending (phone, customer_id, target, params, credits, created_at)
       VALUES ('(484)507-6216', $1, 'new', '{}'::jsonb, 5, '2026-01-03T00:00:00Z')`,
      [DUP]
    );

    // Credits: three buckets on KEEP, two on DUP (comps has no DUP row). Merge = SUM.
    await pool.query(
      `INSERT INTO credit_balances (location_id, credit_type, balance) VALUES
         ($1, 'report', 100), ($1, 'skiptrace', 10), ($1, 'comps', 10),
         ($2, 'report', 25),  ($2, 'skiptrace', 5)`,
      [KEEP, DUP]
    );
    await pool.query(
      `INSERT INTO credit_ledger (location_id, amount, balance_after, reason, credit_type) VALUES
         ($1, 100, 100, 'manual_grant', 'report'),
         ($2, 25, 25, 'manual_grant', 'report'),
         ($2, -1, 24, 'text_lookup', 'report')`,
      [KEEP, DUP]
    );

    // Apply the dedup migration TWICE to prove idempotency in one pass.
    await pool.query(readMigration(THIS_MIGRATION));
    await pool.query(readMigration(THIS_MIGRATION));
  });

  afterAll(async () => {
    await pg.stop();
  });

  it("collapses the pair to the ONE named row, in canonical E.164", async () => {
    const rows = await pool.query<{ id: string; phone: string; first_name: string }>(
      `SELECT id, phone, first_name FROM text_jake_customers WHERE phone = $1`,
      [CANON]
    );
    expect(rows.rows).toEqual([{ id: KEEP, phone: CANON, first_name: "Jane" }]);

    // The duplicate row is gone entirely.
    const dup = await pool.query(`SELECT 1 FROM text_jake_customers WHERE id = $1`, [DUP]);
    expect(dup.rowCount).toBe(0);
  });

  it("canonicalizes a singleton's formatted phone in place", async () => {
    const solo = await pool.query<{ phone: string }>(
      `SELECT phone FROM text_jake_customers WHERE id = $1`,
      [SOLO]
    );
    expect(solo.rows[0].phone).toBe(SOLO_CANON);
  });

  it("re-points every child row to the kept customer with a canonical phone — zero loss", async () => {
    // All three messages (1 kept + 2 dup) now belong to KEEP, all in canonical form.
    const msgs = await pool.query<{ n: string; phones: string }>(
      `SELECT count(*)::text AS n, string_agg(DISTINCT phone, ',') AS phones
       FROM text_jake_conversation_messages WHERE customer_id = $1`,
      [KEEP]
    );
    expect(Number(msgs.rows[0].n)).toBe(3);
    expect(msgs.rows[0].phones).toBe(CANON);

    // Nothing left dangling on the deleted duplicate id.
    for (const table of [
      "text_jake_conversation_messages",
      "text_jake_lookups",
      "text_jake_skip_traces",
      "text_jake_comps",
    ]) {
      const orphan = await pool.query(`SELECT 1 FROM ${table} WHERE customer_id = $1`, [DUP]);
      expect(orphan.rowCount).toBe(0);
    }

    // Each cache row moved to KEEP with the canonical phone (none dropped).
    for (const table of ["text_jake_lookups", "text_jake_skip_traces", "text_jake_comps"]) {
      const kept = await pool.query<{ phone: string }>(
        `SELECT phone FROM ${table} WHERE customer_id = $1`,
        [KEEP]
      );
      expect(kept.rowCount).toBe(1);
      expect(kept.rows[0].phone).toBe(CANON);
    }
  });

  it("merges credit balances per bucket as SUM(kept + duplicate)", async () => {
    const store = new CreditLedgerStoreLite(asDb(pool));
    expect(await store.balance(KEEP, "report")).toBe(125); // 100 + 25
    expect(await store.balance(KEEP, "skiptrace")).toBe(15); // 10 + 5
    expect(await store.balance(KEEP, "comps")).toBe(10); // 10 + 0
    // The duplicate's balance rows are gone.
    const dupBal = await pool.query(`SELECT 1 FROM credit_balances WHERE location_id = $1`, [DUP]);
    expect(dupBal.rowCount).toBe(0);
  });

  it("re-points the full ledger audit trail to the kept account — nothing lost", async () => {
    const dup = await pool.query(`SELECT 1 FROM credit_ledger WHERE location_id = $1`, [DUP]);
    expect(dup.rowCount).toBe(0);
    // All 3 seeded ledger rows (1 on KEEP + 2 on DUP) now sit under KEEP.
    const kept = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM credit_ledger WHERE location_id = $1`,
      [KEEP]
    );
    expect(Number(kept.rows[0].n)).toBe(3);
  });

  it("keeps the newest pending row on a canonical-phone collision, re-pointed to the kept row", async () => {
    const pend = await pool.query<{ phone: string; customer_id: string; target: string }>(
      `SELECT phone, customer_id, target FROM text_jake_comps_pending`
    );
    expect(pend.rows).toEqual([{ phone: CANON, customer_id: KEEP, target: "new" }]);
  });

  it("rejects a future duplicate: a raw insert of the same canonical phone violates UNIQUE(phone)", async () => {
    await expect(
      pool.query(`INSERT INTO text_jake_customers (phone) VALUES ($1)`, [CANON])
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("the store lookup matches regardless of the format it is given", async () => {
    const store = new TextJakeCustomerStore(asDb(pool));
    const byFormatted = await store.findByPhone("(484) 507-6216");
    const byE164 = await store.findByPhone("+14845076216");
    const byBare = await store.findByPhone("484.507.6216");
    expect(byFormatted?.id).toBe(KEEP);
    expect(byE164?.id).toBe(KEEP);
    expect(byBare?.id).toBe(KEEP);
  });
});

/** Tiny read-only helper for per-bucket balances (avoids pulling the full store). */
class CreditLedgerStoreLite {
  constructor(private readonly db: PostgresDatabase) {}
  async balance(locationId: string, creditType: string): Promise<number> {
    const r = await this.db.query<{ balance: number }>(
      `SELECT balance FROM credit_balances WHERE location_id = $1 AND credit_type = $2`,
      [locationId, creditType]
    );
    return r.rows[0]?.balance ?? 0;
  }
}
