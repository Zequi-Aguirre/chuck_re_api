# Logic and Rules

This document defines the decision-making logic for lead qualification and the mapping of fields retrieved from RealEstateAPI.

## Objective
Determine whether a property lead should be **qualified** or **disqualified** based on real estate data such as listing status, sale history, and mortgage information.

---

## RealEstateAPI → GoHighLevel Field Mapping

| GHL Custom Field | Source (RealEstateAPI JSON Path) | Description |
|------------------|----------------------------------|-------------|
| `re_owner_name` | `ownerInfo.owner1FullName` | Full name of the property owner |
| `re_active_listed` | `mlsActive` or `mlsHistory[].status` | Indicates if property is currently active in MLS |
| `re_last_listed_price` | `mlsHistory[].price` | Most recent listed price |
| `re_last_listed_date` | `mlsHistory[].statusDate` | Date of most recent listing |
| `re_last_sold_date` | `lastSale.saleDate` | Last recorded sale date |
| `re_mortgage_amount` | `mortgageHistory[].amount` | Highest recorded mortgage amount |
| `re_foreclosure_active` | `foreclosureInfo[].active` | Whether foreclosure is active |
| `re_checked_at` | System timestamp | Time the enrichment ran |

---

## Disqualification Rules

| Rule | Condition | Result |
|------|------------|---------|
| Active Listing | `isActiveListed == true` | **Disqualify** with reason `ACTIVE_LISTED` |
| Recent Sale | `lastSoldDate > 2022-12-31` | **Disqualify** with reason `SOLD_AFTER_2022` |
| No Property Match | `propertyId == null` | **Disqualify** with reason `NO_PROPERTY_MATCH` |
| (Future) Mobile Home | `propertyType == 'Mobile Home'` | **Disqualify** with reason `MOBILE_HOME` |

A lead can have multiple disqualify reasons.

The final `disqualify` flag is computed as:
```ts
disqualify = disqualifyReasons.length > 0;
```

---

## GoHighLevel Tagging Logic

| Tag | When Applied | Purpose |
|-----|---------------|----------|
| `DQ_ACTIVE_LISTED` | Property is actively listed | Exclude from campaigns |
| `DQ_SOLD_AFTER_2022` | Property sold after 2022 | Exclude from outreach |
| `DQ_NO_MATCH` | Could not find property in RealEstateAPI | For review |
| `QUALIFIED` | None of the disqualify rules matched | Proceed to texting |

---

## Future Extensions

Planned rules for more granular qualification include:
- **Equity Filter** → Estimate from mortgage vs. last sale price.
- **Property Type Filter** → Exclude condos or vacant land.
- **Owner Occupancy Check** → Flag absentee owners differently.
- **Foreclosure Intelligence** → Score urgency for follow-up.

---

## Rule Evaluation Flow

1. Get property details from RealEstateAPI.
2. Evaluate rule conditions in priority order.
3. Accumulate reason codes.
4. Write results + tags to GoHighLevel.
5. Emit logs for observability (recommended future step).

---
This file serves as the single source of truth for the enrichment decision model used by `LeadEnrichmentService`.

For operational behavior and retries, see `docs/ai/WORKER_AND_QUEUE_GUIDE.md`.