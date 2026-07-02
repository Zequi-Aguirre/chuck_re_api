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
  /**
   * Normalized single-line address. Optional on the multi-tenant path (JAK-106+):
   * the enrichment worker (JAK-107) loads the contact from GHL to get the address,
   * so the webhook doesn't have to supply it. The single-tenant MVP path still passes it.
   */
  full_address?: string;
  /**
   * GHL sub-account (location) the contact belongs to. Present on the multi-tenant
   * enrichment path (JAK-106 webhook) so the worker resolves the right per-location
   * connection (JAK-102). Absent on the legacy single-tenant MVP path.
   */
  location_id?: string;
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