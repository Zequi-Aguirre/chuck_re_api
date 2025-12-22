# Architecture Overview

This service follows a **Resource → Service → DAO** pattern, consistent with all AskZack/Chuck backend modules.

## Request Flow

1. GoHighLevel triggers a webhook (`/webhooks/ghl/lead-imported`).
2. The request is received by **`GhlWebhookResource`**.
3. The resource enqueues a new job using **`LeadEnrichmentQueueService`**.
4. A background worker (**`LeadEnrichmentWorker`**) consumes the queue.
5. The worker calls **`LeadEnrichmentService`**, which:
   - Uses **`RealEstateApiDao`** to get property details.
   - Uses **`GhlApiDao`** to update lead info in GoHighLevel.
6. The worker marks the job as completed (or retries on transient errors).

## Core Layers

| Layer | Folder | Description |
|-------|---------|-------------|
| Resource | `/resources` | HTTP endpoints (Express routers) |
| Service | `/services` | Business logic and orchestration |
| DAO | `/data` | External API access |
| Worker | `/worker` | Background job consumers |
| Config | `/config` | Environment and Redis setup |

The system is **event-driven**, not request-blocking: jobs are queued, processed asynchronously, and retried automatically.