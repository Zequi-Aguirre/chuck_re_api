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

    console.log(`ℹ️ Fetched property data for ${full_address}:`, propertyData);

    // Prepare result matching EnrichmentResult interface
    const result: EnrichmentResult = {
      ownerName: propertyData.ownerName ?? null,
      isActiveListed: propertyData.isActiveListed ? 'YES' : 'NO',
      lastSalePrice: propertyData.lastSalePrice ?? null,
      lastSoldDate: propertyData.lastSoldDate ? new Date(propertyData.lastSoldDate).toISOString().split('T')[0] : null,
      mortgageAmount: propertyData.mortgageAmount ?? null,
      foreclosureActive: propertyData.foreclosureActive ?? false,
      disqualify: false, // Default until logic is added
      disqualifyReasons: [],
    };

    console.log(`ℹ️ Enrichment data for ${contact_id}:`, result);

    // Update GHL contact with enriched data
    await this.ghlDao.updateContactCustomFields(contact_id, result);
    console.log(`✅ Lead enrichment completed for ${contact_id}`);
  }
}