import * as fs from "fs";
import * as path from "path";
import { Pool } from "pg";
import {
  EphemeralPostgres,
  startEphemeralPostgres,
} from "../../../testSupport/ephemeralPostgres";

/**
 * JAK-186 — REAL-Postgres integration test for the auto-enrichment toggle migration.
 *
 * A mock DB can't prove the column actually lands on the production schema, that it
 * DEFAULTS false (opt-in) for rows that predate it, or that the migration is
 * re-runnable. This test applies the ENTIRE production migration chain from v0
 * (postgrator convention: `<yyyyMMddHHmmss>.do._<name>.sql`, in order), then pins:
 *
 *   - a connection row inserted with only the required columns gets
 *     auto_enrichment_enabled = false (the opt-in default);
 *   - the flag round-trips true/false through an UPDATE;
 *   - re-applying the migration is a no-op (idempotent — IF NOT EXISTS).
 */

const MIGRATIONS = path.resolve(__dirname, "../../../../../..", "postgres", "migrations");
const THIS_MIGRATION = "20260708162015.do._jak186_add_auto_enrichment_toggle.sql";

const allMigrations = (): string[] =>
  fs
    .readdirSync(MIGRATIONS)
    .filter((f) => /^\d{14}\.do\._.+\.sql$/.test(f))
    .sort();

const readMigration = (file: string) => fs.readFileSync(path.join(MIGRATIONS, file), "utf8");

describe("Auto-enrichment toggle migration (real Postgres) — JAK-186", () => {
  jest.setTimeout(60_000);

  let pg: EphemeralPostgres;
  let pool: Pool;

  beforeAll(async () => {
    pg = await startEphemeralPostgres();
    pool = pg.pool;
    await pool.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);

    // Apply the full chain, in order, from v0 — the production schema exactly.
    for (const file of allMigrations()) {
      await pool.query(readMigration(file));
    }
  });

  afterAll(async () => {
    await pg.stop();
  });

  const insertBareConnection = async (locationId: string): Promise<void> => {
    // Insert with ONLY the columns present before JAK-186 — proves the new column
    // has a working default for rows that don't set it.
    await pool.query(
      `INSERT INTO ghl_connections (location_id, api_key_encrypted, base_url)
       VALUES ($1, 'v1:enc:blob', 'https://services.leadconnectorhq.com')`,
      [locationId]
    );
  };

  it("adds auto_enrichment_enabled defaulting to FALSE (opt-in)", async () => {
    await insertBareConnection("loc_default");

    const { rows } = await pool.query(
      `SELECT auto_enrichment_enabled FROM ghl_connections WHERE location_id = $1`,
      ["loc_default"]
    );
    expect(rows[0].auto_enrichment_enabled).toBe(false);
  });

  it("is NOT NULL — an explicit null insert is rejected", async () => {
    await expect(
      pool.query(
        `INSERT INTO ghl_connections (location_id, api_key_encrypted, base_url, auto_enrichment_enabled)
         VALUES ('loc_null', 'v1:enc:blob', 'https://x.co', NULL)`
      )
    ).rejects.toThrow();
  });

  it("round-trips the toggle true/false through an UPDATE", async () => {
    await insertBareConnection("loc_toggle");

    await pool.query(
      `UPDATE ghl_connections SET auto_enrichment_enabled = true WHERE location_id = $1`,
      ["loc_toggle"]
    );
    let res = await pool.query(
      `SELECT auto_enrichment_enabled FROM ghl_connections WHERE location_id = $1`,
      ["loc_toggle"]
    );
    expect(res.rows[0].auto_enrichment_enabled).toBe(true);

    await pool.query(
      `UPDATE ghl_connections SET auto_enrichment_enabled = false WHERE location_id = $1`,
      ["loc_toggle"]
    );
    res = await pool.query(
      `SELECT auto_enrichment_enabled FROM ghl_connections WHERE location_id = $1`,
      ["loc_toggle"]
    );
    expect(res.rows[0].auto_enrichment_enabled).toBe(false);
  });

  it("is idempotent — re-applying the migration is a clean no-op", async () => {
    await expect(pool.query(readMigration(THIS_MIGRATION))).resolves.toBeDefined();
    // The column still exists exactly once and behaves the same.
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n
         FROM information_schema.columns
        WHERE table_name = 'ghl_connections' AND column_name = 'auto_enrichment_enabled'`
    );
    expect(rows[0].n).toBe(1);
  });
});
