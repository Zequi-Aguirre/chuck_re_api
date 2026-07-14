import * as fs from "fs";
import * as path from "path";
import { Pool } from "pg";
import { PostgresDatabase } from "../../../data/PostgresDatabase";
import { ConversationStore } from "../ConversationStore";
import {
  EphemeralPostgres,
  startEphemeralPostgres,
} from "../../../testSupport/ephemeralPostgres";

/**
 * JAK-140 — REAL-Postgres integration test for {@link ConversationStore}.
 *
 * The staging P0 (`error: function min(uuid) does not exist`) came from
 * `resolvedAddresses` aggregating a uuid column (`MIN(id)`) — a fault a mock DB
 * can never surface because it never runs the SQL. This test exercises the ACTUAL
 * SQL against a throwaway Postgres, over the REAL production DDL (so `id` is a
 * genuine `uuid`), so any `min(uuid)`-class regression fails here loudly.
 *
 * It seeds a realistic per-phone history — several distinct addresses, a REPEAT of
 * an earlier one, an outbound reply, a non-address inbound, and another phone's
 * traffic — then pins the ordered "Nth address I sent" list the JAK-135
 * orchestrator resolves references against.
 */

const MIGRATIONS = path.resolve(__dirname, "../../../../../..", "postgres", "migrations");
const readMigration = (file: string) => fs.readFileSync(path.join(MIGRATIONS, file), "utf8");

/** Adapt a raw pool to the tiny surface ConversationStore uses (`query`). */
const asDb = (pool: Pool): PostgresDatabase =>
  ({ query: (text: string, params?: unknown[]) => pool.query(text, params) } as unknown as PostgresDatabase);

const PHONE = "+15550000000";
const OTHER_PHONE = "+15559999999";
const ADDR_A = "100 First St, Town, CA 90000";
const ADDR_B = "200 Second Ave, Town, CA 90000";
const ADDR_C = "300 Third Blvd, Town, CA 90000";

describe("ConversationStore (real Postgres integration) — JAK-140", () => {
  jest.setTimeout(60_000); // initdb + first boot can take a few seconds.

  let pg: EphemeralPostgres;
  let pool: Pool;
  let store: ConversationStore;
  let customerId: string;

  const seedInbound = (phone: string, address: string | null, at: string) =>
    pool.query(
      `INSERT INTO text_jake_conversation_messages
         (customer_id, phone, direction, body, resolved_address, created_at)
       VALUES ($1, $2, 'inbound', $3, $4, $5)`,
      [customerId, phone, address ?? "hi", address, at]
    );

  beforeAll(async () => {
    pg = await startEphemeralPostgres();
    pool = pg.pool;

    // Real production DDL. A minimal text_jake_customers stub stands in for the FK
    // target so we exercise the exact conversation/lookup column types (uuid id,
    // timestamptz) without pulling the whole migration chain.
    await pool.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
    await pool.query(
      `CREATE TABLE text_jake_customers (id uuid PRIMARY KEY DEFAULT gen_random_uuid())`
    );
    await pool.query(readMigration("20260703024250.do._create_text_jake_conversation_messages.sql"));
    await pool.query(readMigration("20260703024255.do._create_text_jake_lookups.sql"));

    const cust = await pool.query<{ id: string }>(
      `INSERT INTO text_jake_customers DEFAULT VALUES RETURNING id`
    );
    customerId = cust.rows[0].id;
    store = new ConversationStore(asDb(pool));

    // First-appearance order A, B, C. A is REPEATED after B (must not re-order or
    // duplicate). Plus: an outbound reply, a non-address inbound, and another
    // phone — all of which must be excluded from this phone's ordered list.
    await seedInbound(PHONE, ADDR_A, "2026-07-03T10:00:00Z");
    await seedInbound(PHONE, ADDR_B, "2026-07-03T10:05:00Z");
    await seedInbound(PHONE, ADDR_A, "2026-07-03T10:10:00Z"); // repeat of A
    await seedInbound(PHONE, ADDR_C, "2026-07-03T10:15:00Z");
    await seedInbound(PHONE, null, "2026-07-03T10:20:00Z"); // non-address inbound
    await pool.query(
      `INSERT INTO text_jake_conversation_messages
         (customer_id, phone, direction, body, resolved_address, created_at)
       VALUES ($1, $2, 'outbound', 'report', $3, '2026-07-03T10:06:00Z')`,
      [customerId, PHONE, ADDR_B] // outbound carrying an address — must be ignored
    );
    await seedInbound(OTHER_PHONE, "999 Elsewhere Rd, Town, CA 90000", "2026-07-03T09:00:00Z");
  });

  afterAll(async () => {
    await pg.stop();
  });

  it("runs resolvedAddresses on real Postgres WITHOUT a min(uuid) error, ordered by first send", async () => {
    // The regression assertion: the OLD `ORDER BY MIN(created_at), MIN(id)` throws
    // `function min(uuid) does not exist` right here on real Postgres.
    const list = await store.resolvedAddresses(PHONE);

    // Distinct, oldest-first by FIRST appearance; the A repeat keeps A at ordinal 1.
    expect(list).toEqual([ADDR_A, ADDR_B, ADDR_C]);
    // JAK-135 ordinal semantics the orchestrator depends on.
    expect(list[0]).toBe(ADDR_A); // "the 1st address I sent"
    expect(list[1]).toBe(ADDR_B); // "the 2nd address I sent"
    expect(list[list.length - 1]).toBe(ADDR_C); // "the last one"
  });

  it("returns [] for a phone with no resolved addresses", async () => {
    expect(await store.resolvedAddresses("+15550001111")).toEqual([]);
  });

  it("orders deterministically when two addresses share an exact created_at (tiebreaker)", async () => {
    const tiePhone = "+15550002222";
    const tie = "2026-07-03T11:00:00Z";
    // Insert E before D, but at the SAME timestamp: the resolved_address tiebreaker
    // must yield a stable, deterministic order independent of physical row/uuid.
    await seedInbound(tiePhone, "500 Echo St, Town, CA 90000", tie);
    await seedInbound(tiePhone, "400 Delta St, Town, CA 90000", tie);

    const first = await store.resolvedAddresses(tiePhone);
    const second = await store.resolvedAddresses(tiePhone);
    expect(first).toEqual(["400 Delta St, Town, CA 90000", "500 Echo St, Town, CA 90000"]);
    expect(second).toEqual(first); // stable across runs
  });

  it("exercises the sibling ORDER BY <uuid> DESC read/write paths on real Postgres", async () => {
    // recordLookup uses MAX(order_index) (integer) + ORDER BY id DESC on a uuid PK;
    // these are valid on Postgres but must be proven to execute, not just mocked.
    await store.recordLookup({
      customerId,
      phone: PHONE,
      messageId: null,
      normalizedAddress: ADDR_A,
      addressKey: "100 first st, town, ca 90000",
      propertyId: "987",
      propertyRecord: { id: 987 },
      reportText: "Jake Property Report",
    });

    await expect(store.recentMessages(PHONE, 5)).resolves.toBeDefined();
    await expect(store.lastResolvedAddress(PHONE)).resolves.toBe(ADDR_C);
    await expect(
      store.latestLookup(PHONE, "100 first st, town, ca 90000")
    ).resolves.toMatchObject({ order_index: 1 });
  });
});
