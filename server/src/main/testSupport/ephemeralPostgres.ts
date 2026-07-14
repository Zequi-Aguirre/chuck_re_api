/**
 * JAK-140 — a throwaway, self-contained Postgres for integration tests.
 *
 * Text-Jake's store tests were all mock-based, which is exactly how the
 * `min(uuid) does not exist` bug (an aggregate over a uuid column in
 * {@link import("../ghlEnrichment/conversation/ConversationStore").ConversationStore}.resolvedAddresses)
 * shipped to staging: a mock never runs the SQL, so a Postgres type error is
 * invisible. Any test that must catch a SQL-level fault has to hit a REAL
 * Postgres.
 *
 * This spins up a private, single-use cluster with the local Postgres binaries
 * (`initdb` / `pg_ctl`, the same ones the Homebrew/QA boxes have on PATH) into a
 * temp directory, listening only on a Unix socket inside that directory — no TCP
 * port, so it can never collide with a dev server or another test run. It is the
 * "stand up a throwaway PG like QA does" path: no Docker, no external service.
 *
 * Set `JAKE_TEST_PG_HOST` (+ optional `JAKE_TEST_PG_PORT/USER/PASS/DB`) to point
 * the integration tests at an already-running Postgres instead (e.g. a CI service
 * container); when it is set we connect there and skip booting a cluster.
 */
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Pool } from "pg";

export interface EphemeralPostgres {
  /** A connected pool against the throwaway (or provided) database. */
  pool: Pool;
  /** Shut the pool + (if we booted one) the cluster down and delete its data dir. */
  stop: () => Promise<void>;
}

/** True when the local Postgres server binaries are on PATH. */
export function hasLocalPostgresBinaries(): boolean {
  try {
    execFileSync("initdb", ["--version"], { stdio: "ignore" });
    execFileSync("pg_ctl", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Start (or connect to) a Postgres for one test file. Prefers an externally
 * provided server via `JAKE_TEST_PG_HOST`; otherwise boots a private cluster.
 * Throws if neither is available — a SQL integration test must NOT silently pass
 * without a database, or the very bug class it guards can slip through again.
 */
export async function startEphemeralPostgres(): Promise<EphemeralPostgres> {
  const providedHost = process.env.JAKE_TEST_PG_HOST;
  if (providedHost) {
    const pool = new Pool({
      host: providedHost,
      port: parseInt(process.env.JAKE_TEST_PG_PORT || "5432", 10),
      user: process.env.JAKE_TEST_PG_USER || "postgres",
      password: process.env.JAKE_TEST_PG_PASS || "postgres",
      database: process.env.JAKE_TEST_PG_DB || "postgres",
    });
    return { pool, stop: async () => void (await pool.end()) };
  }

  if (!hasLocalPostgresBinaries()) {
    throw new Error(
      "No Postgres available for the integration test: neither JAKE_TEST_PG_HOST " +
        "is set nor are the `initdb`/`pg_ctl` binaries on PATH. Install Postgres " +
        "(e.g. `brew install postgresql`) or point JAKE_TEST_PG_HOST at a server."
    );
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jake-pg-"));
  const dataDir = path.join(root, "data");
  const socketDir = path.join(root, "sock");
  const logFile = path.join(root, "postgres.log");
  fs.mkdirSync(socketDir);

  // A trust-auth cluster owned by `postgres`; no password needed over the socket.
  execFileSync(
    "initdb",
    ["-D", dataDir, "-U", "postgres", "--auth=trust", "-E", "UTF8", "--no-sync"],
    { stdio: "ignore" }
  );

  // Listen ONLY on the private Unix socket (no TCP) so runs never collide.
  execFileSync(
    "pg_ctl",
    ["-D", dataDir, "-l", logFile, "-w", "-o", `-k ${socketDir} -c listen_addresses=`, "start"],
    { stdio: "ignore" }
  );

  const pool = new Pool({ host: socketDir, user: "postgres", database: "postgres" });

  const stop = async () => {
    await pool.end();
    try {
      execFileSync("pg_ctl", ["-D", dataDir, "-m", "immediate", "-w", "stop"], { stdio: "ignore" });
    } catch {
      // Best-effort; the cluster is disposable and the data dir is removed anyway.
    }
    fs.rmSync(root, { recursive: true, force: true });
  };

  return { pool, stop };
}
