// Core types for the lead enrichment workflow

export type GhlLeadImportedWebhookBody = {
  locationId: string;
  contactId: string;
  address: {
    address1: string;
    city: string;
    state: string;
    postalCode: string;
  };
};

export type EnrichmentJobPayload = {
  locationId: string;
  contactId: string;
  addressString: string; // normalized single-line address
};

export type EnrichmentResult = {
  ownerName: string | null;
  isActiveListed: boolean;
  lastListedPrice: number | null;
  lastListedDate: string | null; // ISO date string
  lastSoldDate: string | null;   // ISO date string
  mortgageAmount: number | null;
  foreclosureActive: boolean;
  disqualify: boolean;
  disqualifyReasons: string[];
};