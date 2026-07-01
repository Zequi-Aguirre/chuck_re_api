#!/usr/bin/env node
// Seed / re-seed the ticket store from a seed JSON snapshot.
//
// Idempotent: upserts each ticket by id via `tix add`, then regenerates
// TICKETS.md. Safe to re-run — existing rows are updated in place, created_at
// is preserved by the store. DB stays the source of truth.
//
//   node tickets/seed.mjs [path/to/tickets.seed.json]
//
// Default source: the committed snapshot at tickets/tickets.seed.json.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TIX = join(HERE, 'tix');
const src = process.argv[2] || join(HERE, 'tickets.seed.json');

const seed = JSON.parse(readFileSync(src, 'utf8'));
const tickets = seed.tickets || [];
const epic = seed.epic || null;

for (const t of tickets) {
  const args = ['add', '--id', t.id, '--title', t.title];
  if (t.priority) args.push('--priority', t.priority);
  if (t.status) args.push('--status', t.status);
  if (epic) args.push('--epic', epic);
  if (Array.isArray(t.depends_on) && t.depends_on.length) {
    args.push('--depends', t.depends_on.join(','));
  }
  if (t.body) args.push('--body', t.body);
  execFileSync(TIX, args, { stdio: 'inherit' });
}

console.log(`\nseeded ${tickets.length} ticket(s) from ${src}`);
