import axios, { AxiosInstance } from 'axios';
import { injectable } from 'tsyringe';
import { EnvConfig } from '../config/EnvConfig';

type PropertySearchResponse = {
  data: Array<{ id: number }>;
};

type PropertyDetailResponse = {
  data: {
    ownerInfo?: { owner1FullName?: string };
    lastSale?: { saleDate?: string };
    mlsActive?: boolean;
    mlsHistory?: Array<{ status?: string; statusDate?: string; price?: number }>;
    mortgageHistory?: Array<{ amount?: number }>;
    foreclosureInfo?: Array<{ active?: boolean }>;
  };
};

@injectable()
export class RealEstateApiDao {
  private readonly http: AxiosInstance;

  constructor(private readonly env: EnvConfig) {
    this.http = axios.create({
      baseURL: this.env.realEstateBaseUrl,
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.env.realEstateApiKey,
      },
      timeout: 30000,
    });
  }

  async findPropertyIdByAddress(addressString: string): Promise<number | null> {
    const resp = await this.http.post<PropertySearchResponse>('/v2/PropertySearch', {
      size: 1,
      address: addressString,
    });

    const first = resp.data.data?.[0];
    return first?.id ?? null;
  }

  async getPropertyDetailById(id: number): Promise<PropertyDetailResponse['data']> {
    const resp = await this.http.post<PropertyDetailResponse>('/v2/PropertyDetail', { id });
    return resp.data.data;
  }
}