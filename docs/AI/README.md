# AI Documentation Index

This directory contains all the AI and backend integration documentation for the **Lead Enrichment Service**.

## 📘 Index

| File | Description |
|------|--------------|
| [ARCHITECTURE_OVERVIEW.md](./ARCHITECTURE_OVERVIEW.md) | Explains the full architecture and data flow from GoHighLevel → RealEstateAPI → Worker → GHL update. |
| [CONFIGURATION_GUIDE.md](./CONFIGURATION_GUIDE.md) | Lists environment variables, Redis setup, and rate-limit configuration. |
| [WORKER_AND_QUEUE_GUIDE.md](./WORKER_AND_QUEUE_GUIDE.md) | Details BullMQ queue setup, concurrency, retries, and operational behavior. |
| [LOGIC_AND_RULES.md](./LOGIC_AND_RULES.md) | Documents disqualification rules, property field mapping, and tagging logic. |
| [EXTENDING_AND_MAINTENANCE.md](./EXTENDING_AND_MAINTENANCE.md) | Outlines how to safely extend, modify, and maintain the system. |

---

## 🧩 Purpose

These documents together describe how the **lead qualification backend** operates, how to configure it, and how to modify it without breaking integrations.

If you're new to the codebase, start with:

👉 **[ARCHITECTURE_OVERVIEW.md](./ARCHITECTURE_OVERVIEW.md)**

Then follow the configuration and logic documents to understand how to adjust processing behavior and integrate additional APIs.

---

## 🛠 Maintenance Notes

- All files here should remain Markdown (.md).
- Each section should reflect the current codebase (update after refactors).
- Keep these docs version-controlled alongside the source.

---

For operational runtime details, refer to:

- `server/src/main/services/LeadEnrichmentService.ts` – Core logic
- `server/src/main/worker/LeadEnrichmentWorker.ts` – Worker process
- `server/src/main/config/envConfig.ts` – Environment variables

---

Maintainers: Zequi Aguirre / AskZack Copilot