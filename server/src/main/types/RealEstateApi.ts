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

/**
 * One email on a /v2/SkipTrace result (JAK-136). The live provider ships emails as
 * plain strings inside a person record; older/other account shapes wrap them in an
 * object. Both are tolerated, so a plain string OR `{ email }` / `{ address }` maps.
 */
export type RealEstateApiSkipTraceEmail = {
    email?: string | null;
    address?: string | null;
    [key: string]: unknown;
};

/**
 * One matched PERSON on a /v2/SkipTrace response (JAK-144). The live provider
 * returns matches as a top-level `persons[]` array — each entry carries the
 * person's name, a structured current `address`, a `phones[]` array (each an
 * object with a `phone` string), and an `emails[]` array of plain strings. Field
 * locations vary by account, so everything is optional and an index signature keeps
 * the mapping forward-compatible; the specialist reads defensively and NEVER
 * fabricates a value that isn't present.
 */
export type RealEstateApiSkipTracePerson = {
    personId?: string | number | null;
    firstName?: string | null;
    lastName?: string | null;
    middleName?: string | null;
    fullName?: string | null;
    name?: string | null;
    age?: string | number | null;
    address?: (RealEstateApiMailingAddress & { streetAddress?: string | null }) | null;
    phones?: RealEstateApiSkipTracePhone[] | null;
    /** Live shape: plain strings. Tolerate `{ email }` / `{ address }` objects too. */
    emails?: Array<string | RealEstateApiSkipTraceEmail> | null;
    [key: string]: unknown;
};

/**
 * A /v2/SkipTrace RESPONSE record (JAK-136 / JAK-144) — the owner/contact lookup
 * for an address (or a named person). The LIVE provider returns matches under a
 * top-level `persons[]` array with a `match` flag; older/other account shapes nest
 * a single identity under `output.identity` or flatten phones/emails onto the
 * record. All are tolerated: everything is optional and an index signature keeps
 * the mapping forward-compatible; the specialist reads persons/phones/emails/name/
 * mailing defensively and NEVER fabricates a value that isn't present.
 */
export type RealEstateApiSkipTraceResult = {
    match?: boolean | null;
    /** Live shape: the matched people (most-relevant first). */
    persons?: RealEstateApiSkipTracePerson[] | null;
    /** Some accounts surface a top-level owner name; others nest it under output.identity. */
    name?: string | null;
    output?: {
        identity?: {
            name?: string | null;
            names?: Array<{ fullName?: string | null; firstName?: string | null; lastName?: string | null } | string> | null;
            address?: RealEstateApiMailingAddress | null;
            phones?: RealEstateApiSkipTracePhone[] | null;
            emails?: Array<string | RealEstateApiSkipTraceEmail> | null;
        } | null;
        demographics?: Record<string, unknown> | null;
        [key: string]: unknown;
    } | null;
    /** Some accounts flatten phones/emails onto the record itself. */
    phones?: RealEstateApiSkipTracePhone[] | null;
    emails?: Array<string | RealEstateApiSkipTraceEmail> | null;
    mailAddress?: RealEstateApiMailingAddress | null;
    [key: string]: unknown;
};

/**
 * The raw HTTP body of a /v2/SkipTrace call. The live provider returns the matches
 * at the TOP LEVEL (`persons[]` + `match`), NOT wrapped under `data` — so the DAO
 * returns the whole body as the {@link RealEstateApiSkipTraceResult}. `data` is kept
 * optional for any legacy account shape that wrapped a single result.
 */
export type RealEstateApiSkipTraceResponse = RealEstateApiSkipTraceResult & {
    data?: RealEstateApiSkipTraceResult | null;
};

export type RealEstateApiPropertyDetailResponse = {
    data: RealEstateApiPropertyDetail;
};

/**
 * One comparable-sale record on a /v3/PropertyComps result (JAK-137). Field
 * locations/casing vary by provider account, so everything is optional and an
 * index signature keeps the mapping forward-compatible; the specialist reads
 * address/price/beds/baths/sqft/distance/date defensively and NEVER fabricates a
 * value that isn't present. `squareFeet` is the comp's living area; `distance` is
 * miles from the subject; `lastSaleAmount`/`lastSaleDate` are the sold price/date.
 */
export type RealEstateApiCompRecord = {
    id?: string | number;
    address?: RealEstateApiAddress | string | null;
    distance?: number | null; // miles from the subject property
    bedrooms?: number | null;
    bathrooms?: number | null;
    squareFeet?: number | null; // living area
    lotSquareFeet?: number | null;
    yearBuilt?: number | null;
    propertyType?: string | null;
    lastSaleAmount?: number | null;
    lastSaleDate?: string | null;
    mlsSoldPrice?: number | null;
    mlsLastStatusDate?: string | null;
    estimatedValue?: number | null;
    latitude?: number | null;
    longitude?: number | null;
    [key: string]: unknown;
};

/**
 * The SUBJECT property echoed back by /v3/PropertyComps (JAK-137). Used to apply
 * the bed/bath/sqft tolerance filters against each comp; every field is optional
 * and an index signature keeps it null-safe.
 */
export type RealEstateApiCompsSubject = {
    id?: string | number;
    address?: RealEstateApiAddress | string | null;
    bedrooms?: number | null;
    bathrooms?: number | null;
    squareFeet?: number | null;
    livingSquareFeet?: number | null;
    lotSquareFeet?: number | null;
    yearBuilt?: number | null;
    lastSaleAmount?: number | null;
    lastSaleDate?: string | null;
    estimatedValue?: number | null;
    [key: string]: unknown;
};

/**
 * A /v3/PropertyComps response (JAK-137) — comparable sales for a subject
 * property. The provider ships the comps under `comps` or `data` depending on the
 * account/version, the subject under `subject`, and an AVM point estimate + range
 * under `reapiAvm`/`reapiAvmLow`/`reapiAvmHigh`; everything is optional and an
 * index signature keeps the mapping forward-compatible. (v2/PropertyComps was
 * deprecated 2026-01-01, so this integrates the current v3 endpoint.)
 */
export type RealEstateApiPropertyCompsResponse = {
    comps?: RealEstateApiCompRecord[] | null;
    data?: RealEstateApiCompRecord[] | null;
    subject?: RealEstateApiCompsSubject | null;
    reapiAvm?: number | null;
    reapiAvmLow?: number | null;
    reapiAvmHigh?: number | null;
    recordCount?: number | null;
    [key: string]: unknown;
};

/**
 * The PropertyDetail body when called with `comps: true` (JAK-144). Our API key is
 * only scoped to pull comparables THIS way — the standalone /v2|/v3 PropertyComps
 * endpoints return 401 AUTH_SCOPE_UNAUTHORIZED for this account. The provider
 * returns the SUBJECT property (its usual PropertyDetail fields, plus a top-level
 * AVM `estimatedValue` and lat/long) with the comparables nested under `comps`. The
 * DAO reshapes this into a {@link RealEstateApiPropertyCompsResponse} for the
 * specialist. Everything is optional and the numeric fields ship as string OR
 * number depending on the field, so the mapper coerces defensively.
 */
export type RealEstateApiPropertyDetailComps = RealEstateApiPropertyDetail & {
    comps?: RealEstateApiCompRecord[] | null;
    estimatedValue?: number | string | null;
    estimatedEquity?: number | string | null;
    latitude?: number | null;
    longitude?: number | null;
    bedrooms?: number | string | null;
    bathrooms?: number | string | null;
    squareFeet?: number | string | null;
};

export type RealEstateApiPropertyDetailCompsResponse = {
    data?: RealEstateApiPropertyDetailComps | null;
    [key: string]: unknown;
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