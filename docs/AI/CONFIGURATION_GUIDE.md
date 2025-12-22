# Configuration Guide

This document explains how to configure and tune the **Lead Enrichment Service** environment for GoHighLevel and RealEstateAPI integration.

## Environment Variables

| Variable | Description | Example |
|-----------|--------------|----------|
| `PORT` | API server port | `8080` |
| `REDIS_URL` | Redis connection string | `redis://localhost:6379` |
| `RE_API_KEY` | API key for RealEstateAPI | `sk_123456789` |
| `RE_BASE_URL` | Base URL for RealEstateAPI | `https://api.realestateapi.com` |
| `GHL_API_KEY` | API key for GoHighLevel | `ghl_xxxxxxxxx` |
| `GHL_BASE_URL` | Base URL for GoHighLevel API | `https://services.leadconnectorhq.com` |
| `ENRICH_QUEUE_NAME` | BullMQ queue name | `lead-enrichment` |
| `ENRICH_RPS` | Max API calls per second | `5` |

## Redis Setup

You must run or connect to a Redis instance. Options:

### Local development
```bash
docker run -d --name redis -p 6379:6379 redis:7-alpine
```

### Hosted Redis providers
- **Upstash** (serverless, free tier available)
- **Redis Cloud** (by Redis Labs)
- **Aiven** (fully managed)
- **Fly.io Redis Addon** (lightweight for testing)

Update your `.env` file:
```env
REDIS_URL=rediss://<your-hosted-redis-url>
```

## Rate Limiting

The RealEstateAPI has per-second and daily rate limits. To stay compliant:
- Configure `ENRICH_RPS` = safe number of property lookups per second (start at 5).
- Use **BullMQ rate limiter** (configured in `LeadEnrichmentWorker`).

Example safe settings:
```env
ENRICH_RPS=5
```

You can increase gradually if 429 errors are rare.

## Local Development
Run the backend:
```bash
npm run local-dev-be
```

The server auto-reloads using **nodemon** and connects to Redis.

## Deployment Checklist
- [ ] Redis reachable and healthy
- [ ] `.env` variables filled
- [ ] Worker process running
- [ ] Rate limit tuned
- [ ] Webhook URL registered in GoHighLevel

---
For production tuning and operational visibility, see `docs/ai/WORKER_AND_QUEUE_GUIDE.md`.