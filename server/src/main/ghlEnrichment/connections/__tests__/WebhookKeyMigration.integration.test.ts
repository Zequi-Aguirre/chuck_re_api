import * as fs from "fs";
import * as path from "path";
import { Pool } from "pg";
import { PostgresDatabase } from "../../../data/PostgresDatabase";
import { GhlConnectionStore } from "../GhlConnectionStore";
import { GhlConnectionService } from "../GhlConnectionService";
import { CredentialCipher } from "../CredentialCipher";
import { GhlEnrichmentConfig } from "../../config/GhlEnrichmentConfig";
import { hashWebhookKey } from "../WebhookKey";
import {
  EphemeralPostgres,
  startEphemeralPostgres,
} from "../../../testSupport/ephemeralPostgres";

/**
 * JAK-189 — REAL-Postgres integration test for the webhook-key migration + backfill.
 *
 * A mock DB can't prove the columns land on the production schema, that the unique
 * hash index is enforced, or that the app-level backfill actually fills EXISTING
 * (pre-migration) rows so no sub-account is left keyless. This applies the ENTIRE
 * production migration chain from v0, then drives the real store + service against
 * the ephemeral pool.
 */

const MIGRATIONS = path.resolve(__dirname, "../../../../../..", "postgres", "migrations");
const THIS_MIGRATION = "20260714140240.do._jak189_add_webhook_key.sql";

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

describe("Webhook-key migration + backfill (real Postgres) — JAK-189", () => {
  jest.setTimeout(60_000);

  let pg: EphemeralPostgres;
  let pool: Pool;
  let cipher: CredentialCipher;
  let service: GhlConnectionService;

  beforeAll(async () => {
    pg = await startEphemeralPostgres();
    pool = pg.pool;
    await pool.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
    for (const file of allMigrations()) {
      await pool.query(readMigration(file));
    }

    cipher = new CredentialCipher({
      credentialEncryptionKey: "integration-test-enc-key",
    } as GhlEnrichmentConfig);
    service = new GhlConnectionService(new GhlConnectionStore(asDb(pool)), cipher);
  });

  afterAll(async () => {
    await pg.stop();
  });

  /** A pre-JAK-189 connection: inserted with NO webhook key columns set. The
   * api_key is a REAL encrypted value so decrypt-on-read (toConnection) works. */
  const insertKeylessConnection = (locationId: string, status = "active") =>
    pool.query(
      `INSERT INTO ghl_connections (location_id, api_key_encrypted, base_url, status)
       VALUES ($1, $2, 'https://x.co', $3)`,
      [locationId, cipher.encrypt("dummy-api-key"), status]
    );

  it("adds nullable webhook_key columns + a unique hash index", async () => {
    const cols = await pool.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'ghl_connections'
          AND column_name IN ('webhook_key_hash', 'webhook_key_enc')`
    );
    expect(cols.rows.map((r) => r.column_name).sort()).toEqual(["webhook_key_enc", "webhook_key_hash"]);

    const idx = await pool.query(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'ghl_connections_webhook_key_hash_idx'`
    );
    expect(idx.rows).toHaveLength(1);
    expect(idx.rows[0].indexdef).toMatch(/UNIQUE/i);
  });

  it("backfills EXISTING keyless rows (active + inactive) with a working key", async () => {
    await insertKeylessConnection("loc_active", "active");
    await insertKeylessConnection("loc_inactive", "inactive");

    const filled = await service.ensureWebhookKeys();
    expect(filled).toBeGreaterThanOrEqual(2);

    // Both rows now have a hash + enc, and resolve BY their decrypted key.
    for (const locationId of ["loc_active", "loc_inactive"]) {
      const key = await service.getWebhookKey(locationId);
      expect(key).not.toBeNull();
      expect(key!.startsWith("jakewh_")).toBe(true);

      const resolved = await service.getByWebhookKey(key!);
      expect(resolved?.locationId).toBe(locationId);
    }

    // Idempotent — a second run fills nothing.
    expect(await service.ensureWebhookKeys()).toBe(0);
  });

  it("createConnection mints a key that resolves back to the new location", async () => {
    const conn = await service.createConnection({
      locationId: "loc_new",
      apiKey: "plaintext-key",
      baseUrl: "https://x.co",
    });
    const key = await service.getWebhookKey(conn.locationId);
    expect(key).not.toBeNull();
    const resolved = await service.getByWebhookKey(key!);
    expect(resolved?.locationId).toBe("loc_new");
  });

  it("regenerate invalidates the old key and issues a new working one", async () => {
    const oldKey = await service.getWebhookKey("loc_new");
    const newKey = await service.regenerateWebhookKey("loc_new");

    expect(newKey).not.toBe(oldKey);
    // Old key no longer resolves; new key does.
    expect(await service.getByWebhookKey(oldKey!)).toBeNull();
    expect((await service.getByWebhookKey(newKey!))?.locationId).toBe("loc_new");
  });

  it("enforces the UNIQUE hash index (no two locations share a key)", async () => {
    const key = await service.getWebhookKey("loc_new");
    await expect(
      pool.query(`UPDATE ghl_connections SET webhook_key_hash = $1 WHERE location_id = 'loc_active'`, [
        hashWebhookKey(key!),
      ])
    ).rejects.toThrow();
  });

  it("is idempotent — re-applying the migration is a clean no-op", async () => {
    await expect(pool.query(readMigration(THIS_MIGRATION))).resolves.toBeDefined();
  });
});
