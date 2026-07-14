const fs = require('fs');
const path = require('path');

// Mirrors Automator's postgres/createMigration.js. Use by running:
//   npm run create-migration <migration_name>
// Emits a postgrator-convention file: <yyyyMMddHHmmss>.do._<name>.sql

// Directory where migrations are stored
const migrationsDir = path.join(__dirname, './migrations');

// Ensure migrations directory exists
if (!fs.existsSync(migrationsDir)) {
    fs.mkdirSync(migrationsDir);
}

// yyyyMMddHHmmss in local time (no date-fns dependency).
const pad = (n) => String(n).padStart(2, '0');
const d = new Date();
const timestamp =
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

const migrationName = process.argv[2] || 'unnamed_migration';
const fileName = `${timestamp}.do._${migrationName}.sql`;

console.log(`Creating migration: ${fileName}`);

// Create empty SQL file
const filePath = path.join(migrationsDir, fileName);
fs.writeFileSync(filePath, '-- Write your migration here\n');

console.log(`Migration created: ${filePath}`);
