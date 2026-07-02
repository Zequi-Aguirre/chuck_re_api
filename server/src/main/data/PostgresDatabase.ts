import { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";
import { injectable } from "tsyringe";
import { EnvConfig } from "../config/envConfig";

/**
 * Thin, lazily-initialized Postgres access point (single shared `pg` pool).
 *
 * This is Jake's first real Postgres dependency (introduced with the JAK-102
 * connection store). The pool is created on FIRST query, not at construction,
 * for two reasons:
 *   1. Boot safety — the server must start cleanly on environments that have no
 *      Postgres provisioned yet (SPEC boots today without a DB). Eager pool
 *      creation would surface a config error at boot for an unrelated feature.
 *   2. DI friendliness — tsyringe can register this as a singleton and callers
 *      resolve it freely; nothing connects until a caller actually runs a query.
 *
 * Connection config follows the HOUSE PATTERN (JAK-117): the discrete
 * DB_HOST/DB_PORT/DB_USER/DB_PASS/DB_DB vars used by Automator + Northstar,
 * NOT a single DATABASE_URL. These are Doppler-provided, app-level secrets —
 * NOT tenant credentials; tenant GHL keys live encrypted in the DB itself.
 */
@injectable()
export class PostgresDatabase {
  private pool?: Pool;

  constructor(private readonly env: EnvConfig) {}

  /** Returns the shared pool, creating it on first use. */
  private getPool(): Pool {
    if (!this.pool) {
      const { dbHost, dbPort, dbUser, dbPass, dbDb } = this.env;
      if (!dbHost?.trim()) {
        throw new Error(
          "Postgres is not configured — the GHL connection store requires the " +
            "DB_HOST/DB_PORT/DB_USER/DB_PASS/DB_DB vars in Doppler."
        );
      }
      this.pool = new Pool({
        host: dbHost,
        port: parseInt(dbPort || "5432", 10),
        user: dbUser,
        password: dbPass,
        database: dbDb,
      });
    }
    return this.pool;
  }

  /** Run a parameterized query on the shared pool. */
  async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: ReadonlyArray<unknown>
  ): Promise<QueryResult<T>> {
    return this.getPool().query<T>(text, params as unknown[] | undefined);
  }

  /**
   * Check out a dedicated client for a multi-statement transaction. Caller is
   * responsible for `release()`. Kept minimal — the store doesn't need it yet,
   * but token refresh (JAK-103) will.
   */
  async connect(): Promise<PoolClient> {
    return this.getPool().connect();
  }

  /** Close the pool (used by tests / graceful shutdown). No-op if never opened. */
  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = undefined;
    }
  }
}
