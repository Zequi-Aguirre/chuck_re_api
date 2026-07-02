import axios, { AxiosInstance } from 'axios';
import { injectable } from 'tsyringe';
import { EnvConfig } from '../config/envConfig';
import { ExternalActionGuard } from '../safety/ExternalActionGuard';
import { EnrichmentResult } from '../types/LeadEnrichment';

@injectable()
export class GhlApiDao {
  private readonly http: AxiosInstance;

  constructor(
    private readonly env: EnvConfig,
    private readonly guard: ExternalActionGuard
  ) {
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

  /**
   * The single outbound chokepoint (SPEC §8 / JAK-110). Every write / tag / SMS
   * on this parked MVP client funnels through here, so dev-safety is enforced in
   * one place: off prod/staging the real HTTP call is echoed + skipped (returns
   * null), never touching a real GHL sub-account. Reads (getContact) bypass it.
   */
  private async outbound<T>(action: string, send: () => Promise<T>): Promise<T | null> {
    if (!this.guard.liveActionsAllowed) {
      this.guard.echoSkipped('GHL outbound', action);
      return null;
    }
    return send();
  }

  async updateContactCustomFields(contactId: string, result: EnrichmentResult): Promise<void> {
    await this.outbound(`update contact ${contactId} custom fields`, () =>
      this.http.put(`/contacts/${contactId}`, {
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
      })
    );
  }

  async applyTag(contactId: string, tag: string): Promise<void> {
    await this.outbound(`apply tag "${tag}" to contact ${contactId}`, () =>
      this.http.post(`/contacts/${contactId}/tags`, {
        tags: [tag],
      })
    );
  }

  /**
   * Send an outbound SMS to a contact via the GHL Conversations API.
   * Uses the same authenticated client (Bearer + Version: 2021-07-28) as the
   * contact/tag calls above. `fromNumber` is optional — when omitted GHL sends
   * from the location's default number. Off prod/staging this is echoed + skipped
   * (JAK-110): dev never sends a real text to a real person.
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

    return this.outbound(`send SMS to contact ${params.contactId}`, async () => {
      const response = await this.http.post('/conversations/messages', body);
      console.log(`📤 SMS sent to contact ${params.contactId}`);
      return response.data;
    });
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