# Worker and Queue Guide

This document explains how background processing works in the **Lead Enrichment Service** using **BullMQ** and **Redis**.

## Overview
The system is designed to handle high-volume lead imports without blocking requests.

- Webhook events from GoHighLevel are received by the API.
- Each event is added to a Redis-backed queue (`lead-enrichment`).
- A separate worker process consumes the queue and performs enrichment asynchronously.

## Components

| Component | Location | Responsibility |
|------------|-----------|----------------|
| `LeadEnrichmentQueueService` | `/services` | Adds jobs to the queue with idempotency and retry configuration. |
| `LeadEnrichmentWorker` | `/worker` | Consumes jobs, processes them, and handles retries or failures. |
| `LeadEnrichmentService` | `/services` | Executes the core business logic (calls RealEstateAPI and GoHighLevel). |

## Queue Configuration

The queue is configured with safe defaults:

```ts
defaultJobOptions: {
  attempts: 3,
  backoff: { type: 'exponential', delay: 30000 }, // 30s, 1m, 2m
  removeOnComplete: 10000,
  removeOnFail: 10000,
}
```

This ensures failed jobs are retried automatically with increasing delay.

## Worker Configuration

Workers are rate-limited and concurrent by design:

```ts
new Worker(env.enrichQueueName, processor, {
  concurrency: 5,
  limiter: {
    max: env.enrichRatePerSecond, // default 5
    duration: 1000,
  },
});
```

### Tuning Guidelines
- **Concurrency** controls how many jobs run in parallel (default = 5).
- **Rate limit** ensures API calls stay under provider thresholds (RealEstateAPI).
- **Backoff** protects against transient errors (429s, network timeouts).

Increase concurrency only if:
- You have enough Redis and API capacity.
- RealEstateAPI rarely returns 429s.

Decrease it if:
- You see repeated rate-limit errors.
- Redis memory or CPU usage increases.

## Running the Worker

Start the worker process independently from the API server:

```bash
npm run worker
```

It will connect to Redis and continuously listen for new jobs. When there are none, it sleeps (no polling).

### Logs
Each job emits events for observability:
- **completed** – when enrichment finishes successfully
- **failed** – when a job fails (with stack trace)
- **stalled** – when a job is stuck and retried automatically

## Error Handling

Transient errors (e.g., API 429 or timeouts) trigger automatic retries.
Permanent failures (bad address, missing data) are logged as `FAILED_FINAL`.

Consider integrating a logging service or database for long-term metrics once the system scales.

## Example Job Lifecycle

1. Webhook received → job queued.
2. Worker picks job → status = PROCESSING.
3. Worker calls RealEstateAPI + GHL.
4. On success → status = SUCCEEDED.
5. On transient error → retry after backoff.
6. On permanent failure → status = FAILED_FINAL.

---
For API field mapping and disqualification logic, see `docs/ai/LOGIC_AND_RULES.md`.