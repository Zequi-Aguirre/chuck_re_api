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

export type RealEstateApiPropertySearchResponse = {
    data: Array<{ id: string | number }>;
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