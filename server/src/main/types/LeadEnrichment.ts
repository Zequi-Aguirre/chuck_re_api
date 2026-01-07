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
  isActiveListed: boolean;
  lastSalePrice: number | null;
  lastSoldDate: string | null;
  mortgageAmount: number | null;
  foreclosureActive: boolean;
  disqualify: boolean;
  disqualifyReasons: string[];
};