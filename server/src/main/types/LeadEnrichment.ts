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
  contact_id: string;
  full_address: string; // normalized single-line address
};

export type EnrichmentResult = {
  ownerName: string | null;
  isActiveListed: string;
  lastSalePrice: number | null;
  lastSoldDate: string | null;   // ISO date string
  mortgageAmount: number | null;
  foreclosureActive: boolean;
  disqualify: boolean;
  disqualifyReasons: string[];
};