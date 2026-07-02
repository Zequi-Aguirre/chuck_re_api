import { injectable } from "tsyringe";
import { GhlApiDao } from "../data/GhlApiDao";
import { RealEstateApiDao } from "../data/RealEstateApiDao";
import { EnrichmentJobPayload, EnrichmentResult } from "../types/LeadEnrichment";

@injectable()
export class LeadEnrichmentService {
  constructor(
      private readonly ghlDao: GhlApiDao,
      private readonly reDao: RealEstateApiDao
  ) {}

  public async processLead(jobData: EnrichmentJobPayload): Promise<void> {
    const { contact_id, full_address } = jobData;

    // The multi-tenant webhook path (JAK-106) enqueues without an address — the
    // reworked worker (JAK-107) loads it from GHL. Until that lands, this legacy
    // single-tenant service requires the address up front and skips without one.
    if (!full_address) {
      console.warn(`⚠️ No address on job for contact ${contact_id} — skipping (JAK-107).`);
      return;
    }

    // Fetch contact details from GHL
    const contact = await this.ghlDao.getContact(contact_id);
    if (!contact) {
      console.warn(`⚠️ Contact not found: ${contact_id}`);
      return;
    }

    // Fetch property details from Real Estate API
    const propertyData = await this.reDao.getEnrichmentDataByAddress(full_address);
    if (!propertyData) {
      console.warn(`⚠️ No property data found for: ${full_address}`);
      return;
    }

    // Prepare result matching EnrichmentResult interface
    const result: EnrichmentResult = {
      ownerName: propertyData.ownerName ?? null,
      isActiveListed: propertyData.isActiveListed,
      lastSalePrice: propertyData.lastSalePrice ?? null,
      lastSoldDate: propertyData.lastSoldDate ? new Date(propertyData.lastSoldDate).toISOString().split('T')[0] : null,
      mortgageAmount: propertyData.mortgageAmount ?? null,
      foreclosureActive: propertyData.foreclosureActive ?? false,
      disqualify: false, // Default until logic is added
      disqualifyReasons: [],
    };

    // Update GHL contact with enriched data
    await this.ghlDao.updateContactCustomFields(contact_id, result);
    console.log(`✅ Lead enrichment completed for ${contact_id}`);
  }
}