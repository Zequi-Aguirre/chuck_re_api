/**
 * JAK-133 — filename guard for postgres migrations.
 *
 * Postgrator refuses to start when two `do` (or two `undo`) migrations share a
 * `yyyyMMddHHmmss` timestamp prefix, and a hand-numbered filename is exactly how
 * that collision sneaks in. The guard is what catches it before a deploy dies.
 * These tests pin: real migrations are clean, collisions are detected, and
 * malformed / hand-numbered-looking names are flagged.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// The guard is plain CommonJS (mirrors postgres/createMigration.js).
const {
  scanMigrationFilenames,
  migrationsDir,
} = require("../../../../postgres/checkMigrationFilenames");

const write = (dir: string, name: string) =>
  fs.writeFileSync(path.join(dir, name), "-- test migration\n");

describe("scanMigrationFilenames", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jak133-migrations-"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("passes clean, uniquely-timestamped migrations", () => {
    write(tmp, "20260702000004.do._create_app_settings.sql");
    write(tmp, "20260702215327.do._update_property_report_prompt_jak132.sql");
    write(tmp, "20260702215327.undo._update_property_report_prompt_jak132.sql");

    const { collisions, malformed } = scanMigrationFilenames(tmp);
    expect(collisions).toEqual([]);
    expect(malformed).toEqual([]);
  });

  it("detects two `do` migrations sharing a timestamp prefix", () => {
    write(tmp, "20260702000005.do._update_property_report_prompt_jak132.sql");
    write(tmp, "20260702000005.do._something_else.sql");

    const { collisions } = scanMigrationFilenames(tmp);
    expect(collisions).toHaveLength(1);
    expect(collisions[0].timestamp).toBe("20260702000005");
    expect(collisions[0].action).toBe("do");
    expect(collisions[0].files).toEqual([
      "20260702000005.do._something_else.sql",
      "20260702000005.do._update_property_report_prompt_jak132.sql",
    ]);
  });

  it("does NOT flag a do/undo pair that shares a timestamp (different action)", () => {
    write(tmp, "20260702000004.do._create_app_settings.sql");
    write(tmp, "20260702000004.undo._create_app_settings.sql");

    const { collisions } = scanMigrationFilenames(tmp);
    expect(collisions).toEqual([]);
  });

  it("flags a malformed / non-timestamp filename", () => {
    write(tmp, "add_column.sql");
    write(tmp, "20260702000004.do._create_app_settings.sql");

    const { malformed } = scanMigrationFilenames(tmp);
    expect(malformed).toEqual(["add_column.sql"]);
  });

  it("ignores non-.sql files", () => {
    write(tmp, "README.md");
    write(tmp, "20260702000004.do._create_app_settings.sql");

    const { collisions, malformed } = scanMigrationFilenames(tmp);
    expect(collisions).toEqual([]);
    expect(malformed).toEqual([]);
  });

  it("the real postgres/migrations directory is collision-free and well-formed", () => {
    const { collisions, malformed } = scanMigrationFilenames(migrationsDir);
    expect(collisions).toEqual([]);
    expect(malformed).toEqual([]);
  });
});
