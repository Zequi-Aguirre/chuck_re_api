import * as fs from "fs";
import * as path from "path";
import { Pool } from "pg";
import { PostgresDatabase } from "../../../data/PostgresDatabase";
import { FooterStore } from "../FooterStore";
import { PropertyReportWriter } from "../../PropertyReportWriter";
import {
  EphemeralPostgres,
  startEphemeralPostgres,
} from "../../../testSupport/ephemeralPostgres";

/**
 * JAK-188 — REAL-Postgres integration test for the footers migration.
 *
 * A mock DB can't prove the table lands on the production schema, that the
 * VALUE-GUARDED SEED inserts the EXACT current default footer as the first active
 * footer (so day-1 is unchanged), or that re-running the migration is a clean
 * no-op. This applies the ENTIRE production migration chain from v0, then pins:
 *
 *   - the seeded footer text EQUALS the code default (PropertyReportWriter.FOOTER)
 *     and is active;
 *   - re-applying the migration inserts NO duplicate (value-guarded, idempotent);
 *   - the FooterStore reads the seed as the one active footer.
 */

const MIGRATIONS = path.resolve(__dirname, "../../../../../..", "postgres", "migrations");
const THIS_MIGRATION = "20260709181927.do._jak188_create_footers.sql";

const allMigrations = (): string[] =>
  fs
    .readdirSync(MIGRATIONS)
    .filter((f) => /^\d{14}\.do\._.+\.sql$/.test(f))
    .sort();

const readMigration = (file: string) => fs.readFileSync(path.join(MIGRATIONS, file), "utf8");

const asDb = (pool: Pool): PostgresDatabase =>
  ({
    query: (text: string, params?: unknown[]) => pool.query(text, params),
  } as unknown as PostgresDatabase);

describe("Footers migration (real Postgres) — JAK-188", () => {
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

  it("seeds the EXACT current default footer as the first ACTIVE footer", async () => {
    const { rows } = await pool.query(
      `SELECT text, active FROM footers ORDER BY created_at ASC`
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toBe(PropertyReportWriter.FOOTER);
    expect(rows[0].text).toBe("Every Lead Deserves Jake.\nGoTextJake.com/CRM");
    expect(rows[0].active).toBe(true);
  });

  it("is idempotent — re-applying the migration inserts NO duplicate seed", async () => {
    await pool.query(readMigration(THIS_MIGRATION));
    await pool.query(readMigration(THIS_MIGRATION));
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM footers`);
    expect(rows[0].n).toBe(1);
  });

  it("the FooterStore reads the seed as the one active footer", async () => {
    const store = new FooterStore(asDb(pool));
    const active = await store.listActive();
    expect(active).toHaveLength(1);
    expect(active[0].text).toBe(PropertyReportWriter.FOOTER);
  });
});
