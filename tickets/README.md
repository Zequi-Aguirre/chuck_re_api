# tickets — Jake's project-local ticket store

`tickets/tickets.db` (SQLite) is the **source of truth**. `tickets/TICKETS.md` is a
**generated** human export — do not hand-edit it. Mutate through the CLI; every
write regenerates the markdown. Mirrors the AskZack `inbox.db`/`inbox.md` pattern.

Zero-dependency: `tix` shells out to the `sqlite3` CLI binary, so the store
travels with the repo (no `npm install`, no native build).

## Usage

```bash
tickets/tix list                     # active tickets (everything but done)
tickets/tix list --all               # include done
tickets/tix list --status open       # filter by status
tickets/tix show JAKE-002            # full body of one ticket
tickets/tix add --id JAKE-099 --title "..." --priority P0 \
  --status open --epic ghl-enrichment --depends JAKE-001,JAKE-002 --body "..."
tickets/tix done JAKE-001            # mark done (or --status blocked/in_progress)
tickets/tix export                   # force-regenerate TICKETS.md
```

Statuses in use: `open`, `in_progress`, `blocked` (deferred), `done`.

## Reseeding

`tickets/seed.mjs` idempotently upserts the ticket set from a seed JSON
(default: the committed snapshot). Safe to re-run:

```bash
node tickets/seed.mjs [path/to/tickets.seed.json]
```
