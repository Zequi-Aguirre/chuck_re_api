# Extending and Maintenance Guide

This document explains how to safely modify, extend, and maintain the **Lead Enrichment Service** architecture without breaking the workflow or overloading external APIs.

---

## 1. Adding New Data Sources (DAOs)

Each external integration (e.g., RealEstateAPI, GoHighLevel) is implemented as a DAO under `/data`.

### To add a new API integration:
1. Create a new file in `/data`, e.g. `ExampleApiDao.ts`.
2. Implement it as a class with typed methods that only perform HTTP I/O.
3. Register it via dependency injection (DI) in the relevant service.
4. Never call DAOs directly from resources — always through a service.

Example:
```ts
@injectable()
export class ExampleApiDao {
  constructor(private readonly env: EnvConfig) {}
  async fetchSomething(id: string): Promise<any> {
    return axios.get(`${this.env.exampleBaseUrl}/v1/resource/${id}`);
  }
}
```

---

## 2. Adding or Changing Business Rules

Rules are centralized in `LeadEnrichmentService` and documented in `docs/ai/LOGIC_AND_RULES.md`.

When adding new rules:
- Add clear reason codes (e.g., `LOW_EQUITY`, `MOBILE_HOME`).
- Update mapping tables in `LOGIC_AND_RULES.md`.
- Avoid hardcoding constants — use configuration or enums where possible.

Example addition:
```ts
if (propertyType === 'Mobile Home') {
  disqualifyReasons.push('MOBILE_HOME');
}
```

Then update tagging logic accordingly.

---

## 3. Updating Configuration

Environment variables are defined in `envConfig.ts` and described in `docs/ai/CONFIGURATION_GUIDE.md`.

If you add new variables:
1. Add them in `envConfig.ts`.
2. Update `.env.example`.
3. Document them in the config guide.

---

## 4. Scaling Queue and Worker

When lead volume grows, you can scale workers horizontally:

```bash
npm run worker &
npm run worker &
```

Each worker shares the same Redis queue and automatically balances load.

Tuning parameters:
- `ENRICH_RPS` → Max jobs per second (rate limit)
- Worker `concurrency` → Jobs in parallel per worker

---

## 5. Common Maintenance Tasks

| Task | File/Folder | Notes |
|------|--------------|-------|
| Update RealEstateAPI fields | `/data/RealEstateApiDao.ts` | Match schema changes |
| Update logic | `/services/LeadEnrichmentService.ts` | Always test rules |
| Adjust rate limits | `.env` (`ENRICH_RPS`) | Start conservative |
| Adjust retry/backoff | `/services/LeadEnrichmentQueueService.ts` | Use exponential backoff |
| Add documentation | `/docs/ai` | Markdown only |

---

## 6. Testing Changes

Before deploying any rule or DAO change:

1. Run unit tests (if present).
2. Manually push sample leads to your webhook.
3. Validate tags and fields appear correctly in GoHighLevel.
4. Confirm no 429 errors from RealEstateAPI.

---

## 7. Deprecation Policy

- Old DAOs can remain for one version cycle before removal.
- Rules marked as deprecated must be logged but not acted upon.
- All removed functionality must be recorded in `CHANGELOG.md`.

---

## 8. Future Maintenance Goals

- Integrate better observability (job metrics, retries, throughput).
- Add a small persistence layer for audit logs.
- Support multiple enrichment profiles (per buyer type).

---
Maintainers should read this file before modifying workflow logic, queue behavior, or API integrations.

For foundational architecture details, see `docs/ai/ARCHITECTURE_OVERVIEW.md`.