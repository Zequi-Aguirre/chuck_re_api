# Jake

Jake — text-Jake (top-of-funnel property lookups by SMS) plus the GoHighLevel
lead-enrichment marketplace app that auto-enriches new contacts in a connected
sub-account.

## Docs

- **[DEPLOY.md](DEPLOY.md)** — copy-paste runbook to bring up **staging on
  Render** (Postgres, env vars, migrations, admin bootstrap, smoke test).
- [docs/ghl-enrichment/SPEC.md](docs/ghl-enrichment/SPEC.md) — product + architecture spec.
- [tickets/](tickets/) — project-local ticket store (`tix`); `tickets/TICKETS.md` is the generated view.

## Local dev

```bash
npm ci
npm run local-dev-be   # backend (Doppler dev config, nodemon)
npm run dev-admin      # admin SPA (vite)
npm test               # jest
```

See [DEPLOY.md](DEPLOY.md) for the full build/boot and env-var reference.
