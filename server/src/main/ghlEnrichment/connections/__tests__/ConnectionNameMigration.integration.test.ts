import * as fs from "fs";
import * as path from "path";
import { Pool } from "pg";
import {
  EphemeralPostgres,
  startEphemeralPostgres,
} from "../../../testSupport/ephemeralPostgres";

/**
 * JAK-190 — REAL-Postgres integration test for the friendly-name migration.
 *
 * Proves the column lands on the production schema, defaults to NULL for rows that
 * predate it (no backfill), round-trips a value, and is idempotent on re-run.
 * Applies the ENTIRE production migration chain from v0.
 */

const MIGRATIONS = path.resolve(__dirname, "../../../../../..", "postgres", "migrations");
const THIS_MIGRATION = "20260714143511.do._jak190_add_connection_name.sql";

const allMigrations = (): string[] =>
  fs
    .readdirSync(MIGRATIONS)
    .filter((f) => /^\d{14}\.do\._.+\.sql$/.test(f))
    .sort();

const readMigration = (file: string) => fs.readFileSync(path.join(MIGRATIONS, file), "utf8");

describe("Connection name migration (real Postgres) — JAK-190", () => {
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

  it("adds a nullable name column that defaults to NULL (no backfill)", async () => {
    await insertBare("loc_noname");
    const { rows } = await pool.query(
      `SELECT name FROM ghl_connections WHERE location_id = $1`,
      ["loc_noname"]
    );
    expect(rows[0].name).toBeNull();
  });

  it("round-trips a friendly name through an UPDATE", async () => {
    await insertBare("loc_named");
    await pool.query(`UPDATE ghl_connections SET name = $1 WHERE location_id = $2`, [
      "Acme Realty",
      "loc_named",
    ]);
    const { rows } = await pool.query(
      `SELECT name FROM ghl_connections WHERE location_id = $1`,
      ["loc_named"]
    );
    expect(rows[0].name).toBe("Acme Realty");
  });

  it("is idempotent — re-applying the migration is a clean no-op", async () => {
    await expect(pool.query(readMigration(THIS_MIGRATION))).resolves.toBeDefined();
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM information_schema.columns
        WHERE table_name = 'ghl_connections' AND column_name = 'name'`
    );
    expect(rows[0].n).toBe(1);
  });
});
