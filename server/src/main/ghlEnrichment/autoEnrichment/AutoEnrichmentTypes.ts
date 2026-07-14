/**
 * Auto-enrichment field types (JAK-184, epic JAK-180).
 *
 * The typed seams for the DETERMINISTIC formatter that turns a REAPI
 * PropertyDetail response (the `subject.*` shape Eric's field spec is written
 * against) into the GoHighLevel auto-enrichment custom-field VALUES.
 *
 *   REAPI PropertyDetail  ──(JAK-184 formatter)──▶  AutoEnrichmentFields
 *                                                        │
 *                                        (JAK-185) maps logical keys → GHL ids
 *                                                        │
 *                                        (JAK-183) wires it into the worker
 *
 * This module owns ONLY the shapes. The value-shaping rules live in
 * {@link import("./PropertyDetailEnrichmentFormatter").formatPropertyDetailEnrichment}.
 *
 * The INPUT shape mirrors the live REAPI payload: every field is optional,
 * numbers arrive as `number | string`, and an index signature keeps mapping
 * null-safe and forward-compatible — the same tolerance the existing
 * {@link import("../../types/RealEstateApi").RealEstateApiPropertySearchResult}
 * types apply to this provider.
 */

/** A REAPI numeric field: a real number, a numeric string, or absent. */
export type ReapiNumberLike = number | string | null | undefined;

/** The subject's postal address block. Only `label` is read by the formatter. */
export interface ReapiEnrichmentAddress {
  label?: string | null;
  [key: string]: unknown;
}

/** Owner-of-record block. The formatter reads the three owner-name fallbacks +
 * the (MONTHS-valued) ownership length. */
export interface ReapiEnrichmentOwnerInfo {
  owner1FullName?: string | null;
  companyName?: string | null;
  ownerNames?: readonly (string | null)[] | null;
  /** Length of ownership in MONTHS (the formatter converts to years). */
  ownershipLength?: ReapiNumberLike;
  [key: string]: unknown;
}

/** Structural facts about the property (beds/baths/size/year/address). */
export interface ReapiEnrichmentPropertyInfo {
  address?: ReapiEnrichmentAddress | null;
  bedrooms?: ReapiNumberLike;
  bathrooms?: ReapiNumberLike;
  livingSquareFeet?: ReapiNumberLike;
  buildingSquareFeet?: ReapiNumberLike;
  /** Lot size fallback when `lotInfo.lotSquareFeet` is absent. */
  lotSquareFeet?: ReapiNumberLike;
  yearBuilt?: ReapiNumberLike;
  [key: string]: unknown;
}

/** Lot block; the primary source for lot size. */
export interface ReapiEnrichmentLotInfo {
  lotSquareFeet?: ReapiNumberLike;
  [key: string]: unknown;
}

/** One foreclosure record. The formatter reads `auctionDate` to render the
 * Auction deal-signal line; a subject may carry several. */
export interface ReapiEnrichmentForeclosureItem {
  auctionDate?: string | null;
  [key: string]: unknown;
}

/** Prior-sale block; the fallback source for last sale date/price. */
export interface ReapiEnrichmentLastSale {
  saleDate?: string | null;
  saleAmount?: ReapiNumberLike;
  [key: string]: unknown;
}

/**
 * The REAPI PropertyDetail subject the formatter consumes. This is the `data`
 * object of a PropertyDetail response (Eric's spec namespaces it `subject.*`).
 * Every field is optional and provider-shaped; {@link extractEnrichmentSubject}
 * unwraps the response envelope to one of these.
 */
export interface ReapiPropertyDetailSubject {
  // ── Deal-signal flags (booleans the provider derives) ───────────────────────
  preForeclosure?: boolean | null;
  auction?: boolean | null;
  taxLien?: boolean | null;
  lien?: boolean | null;
  bankOwned?: boolean | null;
  vacant?: boolean | null;
  inherited?: boolean | null;
  death?: boolean | null;
  deathTransfer?: boolean | null;
  highEquity?: boolean | null;
  freeClear?: boolean | null;
  outOfStateAbsenteeOwner?: boolean | null;
  inStateAbsenteeOwner?: boolean | null;
  absenteeOwner?: boolean | null;
  corporateOwned?: boolean | null;
  investorBuyer?: boolean | null;
  cashBuyer?: boolean | null;
  mobileHome?: boolean | null;
  MFH2to4?: boolean | null;
  MFH5plus?: boolean | null;

  /** Foreclosure records; source of the Auction line's date. */
  foreclosureInfo?: readonly ReapiEnrichmentForeclosureItem[] | null;

  // ── MLS status seams ────────────────────────────────────────────────────────
  mlsActive?: boolean | null;
  mlsStatus?: string | null;

  // ── Property + financial facts ──────────────────────────────────────────────
  propertyType?: string | null;
  estimatedEquity?: ReapiNumberLike;
  equityPercent?: ReapiNumberLike;
  estimatedValue?: ReapiNumberLike;
  openMortgageBalance?: ReapiNumberLike;
  estimatedMortgageBalance?: ReapiNumberLike;
  estimatedMortgagePayment?: ReapiNumberLike;

  ownerInfo?: ReapiEnrichmentOwnerInfo | null;
  propertyInfo?: ReapiEnrichmentPropertyInfo | null;
  lotInfo?: ReapiEnrichmentLotInfo | null;

  lastSaleDate?: string | null;
  lastSalePrice?: ReapiNumberLike;
  lastSale?: ReapiEnrichmentLastSale | null;

  [key: string]: unknown;
}

/**
 * The PropertyDetail response envelope. The provider ships the subject under
 * `data`; some call sites hand it under `subject`. {@link extractEnrichmentSubject}
 * tolerates either (or a bare subject).
 */
export interface ReapiPropertyDetailEnvelope {
  data?: ReapiPropertyDetailSubject | null;
  subject?: ReapiPropertyDetailSubject | null;
  [key: string]: unknown;
}

/** The MLS status the formatter emits — a currently-listed status or not. */
export type MlsStatus = "Listed" | "Off Market";

/**
 * The logical, GHL-agnostic auto-enrichment field values (JAK-184 output).
 *
 * Keyed by LOGICAL field name; JAK-185 maps these to per-location GHL field ids
 * (exactly as {@link import("../fieldMapping/EnrichmentFieldMapper")} does for the
 * JAK-108 path). Every value field is optional: the formatter OMITS a key when the
 * subject has no usable value for it, so a write never clobbers an existing GHL
 * value with a blank. `mlsStatus` is the one always-present field — the spec makes
 * "Off Market" its explicit default.
 */
export interface AutoEnrichmentFields {
  /** Multi-line list of the TRUE deal signals, one per line, in priority order.
   * Omitted when no signal is true. */
  dealSignals?: string;
  /** Always present: "Listed" for any currently-listed MLS status, else "Off Market". */
  mlsStatus: MlsStatus;
  propertyType?: string;
  estimatedEquity?: number;
  equityPercent?: number;
  estimatedValue?: number;
  /** `openMortgageBalance`, falling back to `estimatedMortgageBalance`. */
  mortgageBalance?: number;
  monthlyMortgage?: number;
  ownerOfRecord?: string;
  /** Ownership length rendered as e.g. "15.2 Years" (months → years, 1 decimal). */
  yearsOwned?: string;
  beds?: number;
  baths?: number;
  /** `livingSquareFeet`, falling back to `buildingSquareFeet`. */
  sqFt?: number;
  /** `lotInfo.lotSquareFeet`, falling back to `propertyInfo.lotSquareFeet`. */
  lotSize?: number;
  yearBuilt?: number;
  /** Passed through from `lastSaleDate` → `lastSale.saleDate` (source format kept). */
  lastSaleDate?: string;
  lastSalePrice?: number;
  /** `propertyInfo.address.label`. */
  propertyAddress?: string;
}
