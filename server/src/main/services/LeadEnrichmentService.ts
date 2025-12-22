import { injectable } from 'tsyringe';
import { RealEstateApiDao } from '../data/RealEstateApiDao';
import { GhlApiDao } from '../data/GhlApiDao';
import { EnrichmentJobPayload, EnrichmentResult } from '../types/LeadEnrichment';

@injectable()
export class LeadEnrichmentService {
  constructor(
    private readonly reDao: RealEstateApiDao,
    private readonly ghlDao: GhlApiDao
  ) {}

  /**
   * Process one enrichment job:
   * - Look up the property by address
   * - Fetch detail data
   * - Compute disqualification logic
   * - Write back results to GHL
   */
  public async processJob(payload: EnrichmentJobPayload): Promise<EnrichmentResult> {
    const propertyId = await this.reDao.findPropertyIdByAddress(payload.addressString);

    if (!propertyId) {
      const result: EnrichmentResult = {
        ownerName: null,
        isActiveListed: false,
        lastListedPrice: null,
        lastListedDate: null,
        lastSoldDate: null,
        mortgageAmount: null,
        foreclosureActive: false,
        disqualify: false,
        disqualifyReasons: ['NO_PROPERTY_MATCH'],
      };

      await this.ghlDao.upsertContactCustomFields(payload.locationId, payload.contactId, result);
      await this.ghlDao.applyTag(payload.locationId, payload.contactId, 'ENRICH_NO_MATCH');
      return result;
    }

    const pd = await this.reDao.getPropertyDetailById(propertyId);

    const ownerName = pd.ownerInfo?.owner1FullName ?? null;
    const isActiveListed = Boolean(pd.mlsActive);

    // Extract last listed price/date from MLS history
    const lastMls = (pd.mlsHistory ?? [])
      .slice()
      .sort((a, b) => (a.statusDate ?? '').localeCompare(b.statusDate ?? ''))
      .pop();

    const lastListedPrice = lastMls?.price ?? null;
    const lastListedDate = lastMls?.statusDate ?? null;

    const lastSoldDate = pd.lastSale?.saleDate ?? null;
    const soldAfter2022 = Boolean(lastSoldDate && new Date(lastSoldDate).getUTCFullYear() > 2022);

    const mortgageAmount =
      (pd.mortgageHistory ?? [])
        .map((m) => m.amount ?? 0)
        .sort((a, b) => b - a)[0] || null;

    const foreclosureActive = Boolean((pd.foreclosureInfo ?? []).some((f) => f.active));

    const disqualifyReasons: string[] = [];
    if (isActiveListed) disqualifyReasons.push('ACTIVE_LISTED');
    if (soldAfter2022) disqualifyReasons.push('SOLD_AFTER_2022');

    const disqualify = disqualifyReasons.length > 0;

    const result: EnrichmentResult = {
      ownerName,
      isActiveListed,
      lastListedPrice,
      lastListedDate,
      lastSoldDate,
      mortgageAmount,
      foreclosureActive,
      disqualify,
      disqualifyReasons,
    };

    await this.ghlDao.upsertContactCustomFields(payload.locationId, payload.contactId, result);

    if (disqualify) {
      await this.ghlDao.applyTag(
        payload.locationId,
        payload.contactId,
        `DQ_${disqualifyReasons.join('_')}`
      );
    } else {
      await this.ghlDao.applyTag(payload.locationId, payload.contactId, 'QUALIFIED');
    }

    return result;
  }
}