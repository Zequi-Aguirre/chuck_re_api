import axios, { AxiosInstance } from 'axios';
import { injectable } from 'tsyringe';
import { EnvConfig } from '../config/EnvConfig';
import { EnrichmentResult } from '../types/LeadEnrichment';

@injectable()
export class GhlApiDao {
  private readonly http: AxiosInstance;

  constructor(private readonly env: EnvConfig) {
    this.http = axios.create({
      baseURL: this.env.ghlBaseUrl,
      headers: {
        Authorization: `Bearer ${this.env.ghlApiKey}`,
        'content-type': 'application/json',
      },
      timeout: 30000,
    });
  }

  async upsertContactCustomFields(locationId: string, contactId: string, result: EnrichmentResult): Promise<void> {
    await this.http.put(`/locations/${locationId}/contacts/${contactId}`, {
      customFields: [
        { key: 'owner_name', value: result.ownerName },
        { key: 'active_listed', value: result.isActiveListed ? 'Y' : 'N' },
        { key: 'last_listed_price', value: result.lastListedPrice },
        { key: 'last_listed_date', value: result.lastListedDate },
        { key: 'last_sold_date', value: result.lastSoldDate },
        { key: 'mortgage_amount', value: result.mortgageAmount },
        { key: 'foreclosure_active', value: result.foreclosureActive ? 'Y' : 'N' },
        { key: 'disqualify', value: result.disqualify ? 'Y' : 'N' },
        { key: 'disqualify_reasons', value: result.disqualifyReasons.join(',') },
      ],
    });
  }

  async applyTag(locationId: string, contactId: string, tag: string): Promise<void> {
    await this.http.post(`/locations/${locationId}/contacts/${contactId}/tags`, {
      tags: [tag],
    });
  }
}