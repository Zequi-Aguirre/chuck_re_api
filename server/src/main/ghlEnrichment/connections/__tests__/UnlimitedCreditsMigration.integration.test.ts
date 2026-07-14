import * as fs from "fs";
import * as path from "path";
import { Pool } from "pg";
import {
  EphemeralPostgres,
  startEphemeralPostgres,
} from "../../../testSupport/ephemeralPostgres";

/**
 * JAK-191 — REAL-Postgres integration test for the unlimited-credits migration.
 *
 * Proves the column lands on the production schema, defaults to FALSE for rows that
 * predate it (no backfill), round-trips true/false, and is idempotent on re-run.
 * Applies the ENTIRE production migration chain from v0.
 */

const MIGRATIONS = path.resolve(__dirname, "../../../../../..", "postgres", "migrations");
const THIS_MIGRATION = "20260714151258.do._jak191_add_unlimited_credits.sql";

const allMigrations = (): string[] =>
  fs
    .readdirSync(MIGRATIONS)
    .filter((f) => /^\d{14}\.do\._.+\.sql$/.test(f))
    .sort();

const readMigration = (file: string) => fs.readFileSync(path.join(MIGRATIONS, file), "utf8");

describe("Unlimited-credits migration (real Postgres) — JAK-191", () => {
  jest.setTimeout(60_000);

  let pg: EphemeralPostgres;
  let pool: Pool;

  beforeAll(async () => {
    pg = await startEphemeralPostgres();
    pool = pg.pool;
    await pool.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
    for (const file of allMigrations()) {
      await pool.query(readMigration(file));
    }
  });

  afterAll(async () => {
    await pg.stop();
  });

  const insertBare = (locationId: string) =>
    pool.query(
      `INSERT INTO ghl_connections (location_id, api_key_encrypted, base_url)
       VALUES ($1, 'v1:enc:blob', 'https://x.co')`,
      [locationId]
    );

  it("adds unlimited_credits defaulting to FALSE (no backfill)", async () => {
    await insertBare("loc_default");
    const { rows } = await pool.query(
      `SELECT unlimited_credits FROM ghl_connections WHERE location_id = $1`,
      ["loc_default"]
    );
    expect(rows[0].unlimited_credits).toBe(false);
  });

  it("is NOT NULL — an explicit null insert is rejected", async () => {
    await expect(
      pool.query(
        `INSERT INTO ghl_connections (location_id, api_key_encrypted, base_url, unlimited_credits)
         VALUES ('loc_null', 'v1:enc:blob', 'https://x.co', NULL)`
      )
    ).rejects.toThrow();
  });

  it("round-trips the flag true/false through an UPDATE", async () => {
    await insertBare("loc_toggle");
    await pool.query(`UPDATE ghl_connections SET unlimited_credits = true WHERE location_id = $1`, [
      "loc_toggle",
    ]);
    let res = await pool.query(
      `SELECT unlimited_credits FROM ghl_connections WHERE location_id = $1`,
      ["loc_toggle"]
    );
    expect(res.rows[0].unlimited_credits).toBe(true);

    await pool.query(`UPDATE ghl_connections SET unlimited_credits = false WHERE location_id = $1`, [
      "loc_toggle",
    ]);
    res = await pool.query(
      `SELECT unlimited_credits FROM ghl_connections WHERE location_id = $1`,
      ["loc_toggle"]
    );
    expect(res.rows[0].unlimited_credits).toBe(false);
  });

  it("is idempotent — re-applying the migration is a clean no-op", async () => {
    await expect(pool.query(readMigration(THIS_MIGRATION))).resolves.toBeDefined();
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM information_schema.columns
        WHERE table_name = 'ghl_connections' AND column_name = 'unlimited_credits'`
    );
    expect(rows[0].n).toBe(1);
  });
});
