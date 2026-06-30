import axios, { AxiosInstance } from 'axios';
import { injectable } from 'tsyringe';
import { EnvConfig } from '../config/envConfig';
import { EnrichmentResult } from '../types/LeadEnrichment';

@injectable()
export class GhlApiDao {
  private readonly http: AxiosInstance;

  constructor(private readonly env: EnvConfig) {
    // console log api key and base line
    console.log('GHL API Key:', this.env.ghlApiKey);
    console.log('GHL Base URL:', this.env.ghlBaseUrl);

    this.http = axios.create({
      baseURL: this.env.ghlBaseUrl,
      headers: {
        Authorization: `Bearer ${this.env.ghlApiKey}`,
        Version: "2021-07-28",
        'content-type': 'application/json',
      },
      timeout: 30000,
    });
  }

  async updateContactCustomFields(contactId: string, result: EnrichmentResult): Promise<void> {
    console.log(`Updating contact ${contactId} with enrichment data`, result);
    await this.http.put(`/contacts/${contactId}`, {
      customFields: [
        { key: 'ownername', value: result.ownerName },
        { key: 'isactivelisted', value: result.isActiveListed ? 'YES' : 'NO' },
        { key: 'lastlistedprice', value: result.lastSalePrice },
        { key: 'lastsolddate', value: result.lastSoldDate },
        { key: 'mortgageamount', value: result.mortgageAmount },
        { key: 'foreclosureactive', value: result.foreclosureActive ? 'YES' : 'NO' },
        { key: 'disqualify', value: result.disqualify ? 'YES' : 'NO' },
        { key: 'disqualifyreasons', value: result.disqualifyReasons.join(',') },
      ],
    });
  }

  async applyTag(contactId: string, tag: string): Promise<void> {
    await this.http.post(`/contacts/${contactId}/tags`, {
      tags: [tag],
    });
  }

  /**
   * Send an outbound SMS to a contact via the GHL Conversations API.
   * Uses the same authenticated client (Bearer + Version: 2021-07-28) as the
   * contact/tag calls above. `fromNumber` is optional — when omitted GHL sends
   * from the location's default number.
   */
  async sendSms(params: {
    contactId: string;
    message: string;
    fromNumber?: string;
  }): Promise<any> {
    const body: Record<string, unknown> = {
      type: 'SMS',
      contactId: params.contactId,
      message: params.message,
    };
    if (params.fromNumber) {
      body.fromNumber = params.fromNumber;
    }

    const response = await this.http.post('/conversations/messages', body);
    console.log(`📤 SMS sent to contact ${params.contactId}`);
    return response.data;
  }

  public async getContact(contactId: string): Promise<any | null> {
    try {
      const response = await this.http.get(`/contacts/${contactId}`);
      return response.data.contact || null;
    } catch (error: any) {
      console.error(`❌ Failed to fetch contact ${contactId}`, error.message);
      return null;
    }
  }
}