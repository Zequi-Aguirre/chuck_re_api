import axios, { AxiosInstance, CreateAxiosDefaults } from 'axios';
import { injectable } from 'tsyringe';
import { EnvConfig } from '../config/EnvConfig';

@injectable()
export class RealEstateApiDao {
  private readonly http: AxiosInstance;

  constructor(private readonly env: EnvConfig) {
    const config: CreateAxiosDefaults = {
      baseURL: this.env.realEstateBaseUrl,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.env.realEstateApiKey,
      },
      timeout: 30000,
    };

    this.http = axios.create(config);
  }

  public async findPropertyIdByAddress(addressString: string): Promise<number | null> {
    const resp = await this.http.post<{ data: Array<{ id: number }> }>('/v2/PropertySearch', {
      size: 1,
      address: addressString,
    });

    const first = resp.data.data?.[0];
    return first?.id ?? null;
  }

  public async getPropertyDetailById(id: number): Promise<any> {
    const resp = await this.http.post<{ data: any }>('/v2/PropertyDetail', { id });
    return resp.data.data;
  }
}