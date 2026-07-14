const fs = require('fs');
const path = require('path');

// JAK-133 — Migration filename guard (ported from Automator's
// scripts/validate-migration.ts `scanMigrationFilenames`).
//
// Postgrator applies migrations in the order of their `yyyyMMddHHmmss` prefix
// and refuses to start when two `do` (or two `undo`) migrations share the same
// timestamp. Hand-numbered filenames (e.g. 20260702000005) are exactly how a
// collision — and the broken staging deploy JAK-133 fixed — sneaks in.
//
// Run via:  npm run check:migration-filenames
// Always create migrations with `npm run create-migration <name>` so the
// timestamp is real and unique; NEVER hand-number a filename.

const migrationsDir = path.join(__dirname, 'migrations');

/**
 * Scan a migrations directory for `do`/`undo` migrations that collide on the
 * same 14-digit timestamp prefix, and for filenames that don't follow the
 * `<yyyyMMddHHmmss>.(do|undo)._<name>.sql` convention at all.
 *
 * @param {string} dir - absolute path to the migrations directory
 * @returns {{ collisions: Array<{key: string, timestamp: string, action: string, files: string[]}>, malformed: string[] }}
 */
function scanMigrationFilenames(dir) {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql'));
    const groups = new Map();
    const malformed = [];
    const pattern = /^(\d{14})\.(do|undo)\._.+\.sql$/;

    for (const file of files) {
        const match = pattern.exec(file);
        if (!match) {
            malformed.push(file);
            continue;
        }
        const key = `${match[1]}.${match[2]}`;
        const list = groups.get(key) || [];
        list.push(file);
        groups.set(key, list);
    }

    const collisions = [];
    for (const [key, fileList] of groups) {
        if (fileList.length > 1) {
            const [timestamp, action] = key.split('.');
            collisions.push({ key, timestamp, action, files: fileList.slice().sort() });
        }
    }
    collisions.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    return { collisions, malformed: malformed.sort() };
}

function runScan(dir) {
    const { collisions, malformed } = scanMigrationFilenames(dir);

    if (collisions.length === 0 && malformed.length === 0) {
        console.log(`✅ Migration filename scan: no collisions or malformed names in ${dir}`);
        return 0;
    }

    if (malformed.length > 0) {
        console.error(`❌ Migration filename scan: ${malformed.length} malformed filename(s) in ${dir}`);
        for (const f of malformed) console.error(`    - ${f}`);
        console.error('   Expected: <yyyyMMddHHmmss>.(do|undo)._<name>.sql');
    }

    if (collisions.length > 0) {
        console.error(`❌ Migration filename scan: ${collisions.length} colliding timestamp(s) in ${dir}`);
        for (const c of collisions) {
            console.error(`  ${c.timestamp} (${c.action}):`);
            for (const f of c.files) console.error(`    - ${f}`);
        }
    }

    console.error('');
    console.error('Fix: NEVER hand-number a migration filename. Generate a fresh, unique');
    console.error('real timestamp with `npm run create-migration <name>`.');
    return 1;
}

module.exports = { scanMigrationFilenames, migrationsDir };

if (require.main === module) {
    process.exit(runScan(migrationsDir));
}
