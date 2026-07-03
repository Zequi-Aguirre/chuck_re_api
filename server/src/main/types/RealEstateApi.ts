// server/src/main/types/RealEstateApi.ts

export type RealEstateApiAddress = {
    house?: string | null;
    street?: string | null;
    streetType?: string | null;
    city?: string | null;
    state?: string | null;
    zip?: string | null;
    label?: string | null;
};

export type RealEstateApiOwnerInfo = {
    owner1FullName?: string | null;
    owner2FullName?: string | null;
    ownerType?: string | null;

    // ✅ This is where your provider returns the tax mailing address
    mailAddress?: {
        label?: string | null;
        address?: string | null;
        city?: string | null;
        state?: string | null;
        zip?: string | null;

        // extra fields you might want later
        house?: string | null;
        street?: string | null;
        streetType?: string | null;
        zip4?: string | null;
        county?: string | null;
    } | null;
};

export type RealEstateApiLastSale = {
    saleAmount?: number | null;
    saleDate?: string | null;
};

export type RealEstateApiMlsHistoryItem = {
    status?: string;
    price?: number;
    statusDate?: string;
};

export type RealEstateApiMortgageHistoryItem = {
    amount?: number;
    open?: boolean;
    recordingDate?: string;
};

export type RealEstateApiForeclosureInfoItem = {
    active?: boolean;
    recordingDate?: string;
};

export type RealEstateApiMailingAddress = {
    label?: string | null;
    address?: string | null; // line1
    city?: string | null;
    state?: string | null;
    zip?: string | null;
};

export type RealEstateApiPropertyBasics = {
    propertyType?: string | null;
    bedrooms?: number | null;
    bathrooms?: number | null;
    livingArea?: number | null; // sqft
    lotSize?: number | null; // lot sqft
    yearBuilt?: number | null;
};

export type RealEstateApiPropertyInfo = {
    address?: RealEstateApiAddress;

    propertyType?: string | null;
    bedrooms?: number | null;
    bathrooms?: number | null;

    // ✅ provider uses these names
    livingSquareFeet?: number | null;
    lotSquareFeet?: number | null;

    yearBuilt?: number | null;

    mailingAddress?: RealEstateApiMailingAddress;
};

export type RealEstateApiPropertyDetail = {
    id?: number | string;
    propertyId?: number | string;

    ownerInfo?: RealEstateApiOwnerInfo;

    lastSale?: RealEstateApiLastSale;

    propertyInfo?: RealEstateApiPropertyInfo;

    // Some APIs provide these as top-level too
    lastSalePrice?: number | null;
    lastSaleDate?: string | null;

    mlsActive: boolean;
    mlsSold?: boolean;
    mlsListingPrice?: number | null;
    mlsListingDate?: string | null;
    mlsLastStatusDate?: string | null;
    mlsHistory?: RealEstateApiMlsHistoryItem[];

    mortgageHistory?: RealEstateApiMortgageHistoryItem[];
    foreclosureInfo?: RealEstateApiForeclosureInfoItem[];

    // Mailing fields vary by provider. Keep them optional and map best-effort.
    taxMailingAddress?: RealEstateApiMailingAddress;
    mailingAddress?: RealEstateApiMailingAddress;

    propertyBasics?: RealEstateApiPropertyBasics;
};

/**
 * A single summary record returned by /v2/PropertySearch. The API returns
 * flattened summary fields (unlike PropertyDetail's nested objects), and the
 * exact field set varies by query, so every field is optional and an index
 * signature keeps mapping null-safe and forward-compatible.
 */
export type RealEstateApiPropertySearchResult = {
    id?: string | number;
    address?: RealEstateApiAddress | string | null;
    city?: string | null;
    state?: string | null;
    zip?: string | null;
    propertyType?: string | null;
    bedrooms?: number | null;
    bathrooms?: number | null;
    squareFeet?: number | null;
    lotSquareFeet?: number | null;
    yearBuilt?: number | null;
    estimatedValue?: number | null;
    lastSaleAmount?: number | null;
    lastSaleDate?: string | null;
    owner1FirstName?: string | null;
    owner1LastName?: string | null;
    owner1FullName?: string | null;

    // Second owner + owner classification (present on PropertySearch summaries).
    owner2FirstName?: string | null;
    owner2LastName?: string | null;
    owner2FullName?: string | null;
    ownerType?: string | null;
    ownerOccupied?: boolean | null;

    // Absentee flags the provider derives; we prefer deriving from mailAddress vs
    // the property, but fall back to these when the mailing address is absent.
    absenteeOwner?: boolean | null;
    inStateAbsenteeOwner?: boolean | null;
    outOfStateAbsenteeOwner?: boolean | null;

    // Equity / mortgage signals used for the Ownership + Financials sections.
    equityPercent?: number | null;
    estimatedEquity?: number | null;
    highEquity?: boolean | null;
    freeClear?: boolean | null;
    openMortgageBalance?: number | null;
    estimatedMortgagePayment?: number | null;
    yearsOwned?: number | null;

    // Distress / lien signals (JAK-132). Foreclosure/auction/REO are booleans the
    // provider derives; auctionDate is a string when an auction is scheduled.
    // taxLien and judgment are Yes/No FLAGS — the provider ships NO dollar amount
    // for liens, so we never render one.
    foreclosure?: boolean | null;
    preForeclosure?: boolean | null;
    reo?: boolean | null;
    auction?: boolean | null;
    auctionDate?: string | null;
    taxLien?: boolean | null;
    judgment?: boolean | null;

    // FEMA flood signals; only the zone descriptor is renderable.
    floodZone?: boolean | null;
    floodZoneDescription?: string | null;

    // Owner tax-mailing address — the seam for deriving Absentee / Owner-Occupied.
    mailAddress?: RealEstateApiMailingAddress | null;

    mlsActive?: boolean | null;
    mlsStatus?: string | null;
    [key: string]: unknown;
};

export type RealEstateApiPropertySearchResponse = {
    data: RealEstateApiPropertySearchResult[];
};

/**
 * One phone number on a /v2/SkipTrace result (JAK-136). The provider ships a few
 * shapes across records, so every field is optional and an index signature keeps
 * mapping null-safe; the DAO hands the whole record downstream and the specialist
 * extracts a display number defensively.
 */
export type RealEstateApiSkipTracePhone = {
    phone?: string | null;
    number?: string | null;
    phoneDisplay?: string | null;
    telephone?: string | null;
    type?: string | null;
    phoneType?: string | null;
    isConnected?: boolean | null;
    doNotCall?: boolean | null;
    [key: string]: unknown;
};

/** One email on a /v2/SkipTrace result (JAK-136). */
export type RealEstateApiSkipTraceEmail = {
    email?: string | null;
    address?: string | null;
    [key: string]: unknown;
};

/**
 * A /v2/SkipTrace result record (JAK-136) — the owner/contact lookup for an
 * address (or a named person). Field locations vary by provider account, so
 * everything is optional and an index signature keeps the mapping
 * forward-compatible; the specialist reads phones/emails/name/mailing defensively
 * and NEVER fabricates a value that isn't present.
 */
export type RealEstateApiSkipTraceResult = {
    match?: boolean | null;
    /** Some accounts surface a top-level owner name; others nest it under output.identity. */
    name?: string | null;
    output?: {
        identity?: {
            name?: string | null;
            names?: Array<{ fullName?: string | null; firstName?: string | null; lastName?: string | null } | string> | null;
            address?: RealEstateApiMailingAddress | null;
            phones?: RealEstateApiSkipTracePhone[] | null;
            emails?: RealEstateApiSkipTraceEmail[] | null;
        } | null;
        demographics?: Record<string, unknown> | null;
        [key: string]: unknown;
    } | null;
    /** Some accounts flatten phones/emails onto the record itself. */
    phones?: RealEstateApiSkipTracePhone[] | null;
    emails?: RealEstateApiSkipTraceEmail[] | null;
    mailAddress?: RealEstateApiMailingAddress | null;
    [key: string]: unknown;
};

export type RealEstateApiSkipTraceResponse = {
    data?: RealEstateApiSkipTraceResult | null;
};

export type RealEstateApiPropertyDetailResponse = {
    data: RealEstateApiPropertyDetail;
};

export type MailerEnrichmentResponse = {
    propertyAddress: {
        label: string | null;
        house: string | null;
        street: string | null;
        city: string | null;
        state: string | null;
        zip: string | null;
    };
    owner: {
        owner1FullName: string | null;
        owner2FullName: string | null;
        type: string | null;
    };
    mailingAddress: {
        label: string | null;
        address: string | null;
        city: string | null;
        state: string | null;
        zip: string | null;
    };
    propertyBasics: {
        type: string | null;
        beds: number | null;
        baths: number | null;
        sqft: number | null;
        lotSqft: number | null;
        yearBuilt: number | null;
    };
    mls: {
        active: boolean;
        sold: boolean | null;
        listingPrice: number | null;
        listingDate: string | null;
    };
    mortgage: {
        hasOpen: boolean;
        openCount: number;
        openTotal: number | null;
    };
    foreclosure: {
        active: boolean;
    };
    audit?: {
        propertyId: number | null;
    };
    rawData?: String | null;
};