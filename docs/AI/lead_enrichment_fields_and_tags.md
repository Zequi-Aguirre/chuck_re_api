# Lead Enrichment Fields and Tags

## Overview
This document describes how the **Lead Enrichment Pipeline** works in the Chuck Real Estate API project.
It explains how data flows from GoHighLevel (GHL) into the enrichment system, how property data is retrieved from RealEstateAPI, and how results are written back into GHL using both **custom fields** and **tags**.

---

## 1. Data Flow

### Step-by-Step
1. **Lead Imported to GHL**
   - When a new contact is imported into GoHighLevel, an automation triggers a webhook to your backend.
   - Payload includes `locationId`, `contactId`, and the lead's address.

2. **Webhook → Queue**
   - The `/api/webhooks/ghl/lead-imported` endpoint receives the payload.
   - A job is enqueued in Redis via **BullMQ**.
   - Worker concurrency and rate-limiting ensure safe parallel processing (defaults: 5 jobs/sec).

3. **Worker → RealEstateAPI Lookup**
   - The worker picks up a job and uses `RealEstateApiDao` to:
     - Call `/v2/PropertySearch` to find a property ID.
     - Call `/v2/PropertyDetail` to retrieve full property data.

4. **LeadEnrichmentService Logic**
   - Extracts and normalizes the following information:
     - Owner name
     - MLS active listing status
     - Last listed price/date
     - Last sold date
     - Mortgage amount
     - Foreclosure status
   - Applies disqualify rules (e.g. Active listing or Sold after 2022).

5. **GHL Update**
   - Results are pushed back into GHL via `GhlApiDao`.
   - Both **custom fields** and **tags** are updated for the contact.

---

## 2. Custom Fields (GHL Contact Fields)
These fields are written directly into the contact in GHL so they can be used for filtering, reporting, and resale logic.

| Field Key | Type | Description | Example |
|------------|------|--------------|----------|
| `owner_name` | string | Full name of the property owner | `John Doe` |
| `active_listed` | Y/N | Whether the property is currently listed on MLS | `Y` |
| `last_listed_price` | number | Last known MLS listing price | `425000` |
| `last_listed_date` | date | Last time property was listed | `2024-03-15` |
| `last_sold_date` | date | Last recorded sale date | `2023-01-22` |
| `mortgage_amount` | number | Most recent recorded mortgage amount | `250000` |
| `foreclosure_active` | Y/N | Whether there’s an active foreclosure record | `N` |
| `disqualify` | Y/N | Whether this lead is disqualified | `Y` |
| `disqualify_reasons` | string | Comma-separated reason codes | `ACTIVE_LISTED,SOLD_AFTER_2022` |

---

## 3. Tags (Used for Automation Triggers)
Tags are used to drive GoHighLevel automations, such as starting or stopping campaigns based on qualification results.

| Tag | Trigger | Description |
|-----|----------|-------------|
| `ENRICH_NO_MATCH` | No property found | Lead’s address could not be matched to a RealEstateAPI record. |
| `DQ_ACTIVE_LISTED` | Active listing found | Lead is disqualified due to active MLS listing. |
| `DQ_SOLD_AFTER_2022` | Sold too recently | Lead is disqualified due to sale after 2022. |
| `QUALIFIED` | No disqualify reason | Lead is qualified and ready for follow-up. |

---

## 4. Logic Modification Points

| Purpose | File | Function | Notes |
|----------|------|-----------|-------|
| Change disqualification rules | `server/src/main/services/LeadEnrichmentService.ts` | `processJob()` | Edit `disqualifyReasons` array logic. |
| Change what fields are saved | `server/src/main/data/GhlApiDao.ts` | `upsertContactCustomFields()` | Add or remove custom field mappings. |
| Change tags | `server/src/main/data/GhlApiDao.ts` | `applyTag()` | Add or rename tag constants. |
| Adjust rate limits | `server/src/main/config/envConfig.ts` | ENV var `ENRICH_RPS` | Controls jobs/sec worker rate. |

---

## 5. Rate Limit Configuration
Defined in your environment config (`EnvConfig`).

```env
# Redis connection (Upstash or local)
REDIS_PROVIDER=upstash
UPSTASH_REDIS_URL=https://your-instance.upstash.io
UPSTASH_REDIS_TOKEN=your_token_here

# Queue settings
ENRICH_QUEUE_NAME=lead-enrichment
ENRICH_RPS=5

# Real Estate API
RE_API_KEY=your_real_estate_api_key
RE_BASE_URL=https://api.realestateapi.com

# GoHighLevel API
GHL_API_KEY=your_ghl_api_key
GHL_BASE_URL=https://services.leadconnectorhq.com
```

---

## 6. Adding New Rules
To introduce a new qualification or disqualification rule:
1. Open `LeadEnrichmentService.ts`.
2. Add logic after the property detail fetch.
   Example:
   ```ts
   if (pd.propertyType === 'Mobile Home') {
     disqualifyReasons.push('MOBILE_HOME');
   }
   ```
3. Add the same reason to the `disqualify_reasons` field output.
4. Optionally add a corresponding tag in `GhlApiDao`.

---

## 7. Future Enhancements
- Optional caching layer with TTL to reduce RealEstateAPI calls.
- Bulk job enqueue optimizations.
- Unified tag constants to avoid typos.

---

**Document maintained automatically by AskZack.**
**Last updated:** $(new Date().toISOString())