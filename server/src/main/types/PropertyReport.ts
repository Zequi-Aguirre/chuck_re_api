// server/src/main/types/PropertyReport.ts
//
// The VERIFIED, cleaned property data (JAK-130) handed to the PropertyReportWriter.
//
// This is assembled from a single RealEstateApi PropertySearch summary AFTER the
// lookup: it carries ONLY the fields the API actually returned plus the values we
// derived from them (absentee status, years owned, free-&-clear, occupancy). Any
// field the API didn't return is simply left undefined — never null/blank — so
// both the LLM writer and the deterministic fallback can treat "absent" uniformly
// and omit it. Every value here is ground truth: the writer must never invent or
// alter any of it.

export type OccupancyStatus = "Owner-Occupied" | "Investor-Owned";
export type EquityLevel = "High Equity" | "Low Equity";
export type AbsenteeStatus = "Out-of-State Absentee Owner" | "Absentee Owner";

export interface PropertyReportData {
    /** Street line, e.g. "123 Main St". */
    addressLine1?: string;
    /** City/state/zip line, e.g. "Springfield, IL 62704". */
    addressLine2?: string;

    propertyType?: string;
    bedrooms?: number;
    bathrooms?: number;
    squareFeet?: number;
    /** Lot size in ACRES (already converted from the API's lot sqft). */
    lotAcres?: number;
    yearBuilt?: number;

    estimatedMarketValue?: number;

    owner1?: string;
    owner2?: string;
    equityPercent?: number;
    /** True only when there's no open mortgage (renders as "Free & Clear"). */
    freeAndClear?: boolean;
    equityLevel?: EquityLevel;
    occupancy?: OccupancyStatus;
    absenteeStatus?: AbsenteeStatus;
    yearsOwned?: number;

    /** Last sale date, normalized to MM/DD/YYYY. */
    lastSoldDate?: string;
    salePrice?: number;

    /** FEMA flood zone descriptor, e.g. "AE" (only when the API supplies one). */
    femaFloodZone?: string;
    /** Whether the property is currently listed on MLS (when known). */
    mlsListed?: boolean;
}
