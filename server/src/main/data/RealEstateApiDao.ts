import axios, { AxiosInstance, CreateAxiosDefaults } from "axios";
import { injectable } from "tsyringe";
import { EnvConfig } from "../config/envConfig";
import { EnrichmentResult } from "../types/LeadEnrichment";

type PropertyDetail = {
  ownerInfo?: {
    owner1FullName?: string | null;
    owner2FullName?: string | null;
  };
  lastSale?: {
    saleAmount?: number | null;
    saleDate?: string | null;
  };
  propertyInfo?: {
    address?: {
      house?: string | null;
      street?: string | null;
      zip?: string | null;
      city?: string | null;
      state?: string | null;
      label?: string | null;
    };
  };
  lastSalePrice?: number | null;
  lastSaleDate?: string | null;
  mlsActive?: string | null;
  mlsSold?: boolean;
  mlsListingPrice?: number | null;
  mlsListingDate?: string | null;
  mlsLastStatusDate?: string | null;
  mlsHistory?: Array<{ status?: string; price?: number; statusDate?: string }>;
  mortgageHistory?: Array<{ amount?: number; open?: boolean; recordingDate?: string }>;
  foreclosureInfo?: Array<{ active?: boolean; recordingDate?: string }>;
};

@injectable()
export class RealEstateApiDao {
  private readonly http: AxiosInstance;

  constructor(private readonly env: EnvConfig) {
    const config: CreateAxiosDefaults = {
      baseURL: this.env.realEstateBaseUrl,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "x-api-key": this.env.realEstateApiKey,
      },
      timeout: 30000,
    };

    this.http = axios.create(config);
  }

  /**
   * PropertySearch fallback — fuzzy lookup for when parsing or detail lookup fails.
   */
  public async findPropertyIdByAddress(addressString: string): Promise<number | null> {
    try {
      const resp = await this.http.post<{ data: Array<{ id: string | number }> }>("/v2/PropertySearch", {
        size: 5,
        address: addressString,
      });

      const first = resp.data.data?.[0];
      const idStr = first?.id;
      const id = typeof idStr === "string" ? Number(idStr) : idStr;
      return Number.isFinite(id) ? id : null;
    } catch (err: any) {
      console.error(`❌ PropertySearch error: ${err.message}`);
      return null;
    }
  }

  /**
   * Deterministic PropertyDetail call using address parts (preferred).
   */
  public async getPropertyDetailByAddress(parts: {
    house: string;
    street: string;
    city: string;
    state: string;
    zip: string;
  }): Promise<PropertyDetail | null> {
    try {
      const resp = await this.http.post<{ data: PropertyDetail }>("/v2/PropertyDetail", parts);
      return resp.data.data ?? null;
    } catch (err: any) {
      console.error(`❌ PropertyDetail (by address) error: ${err.message}`);
      return null;
    }
  }

  /**
   * Fallback: PropertyDetail by property ID.
   */
  public async getPropertyDetailById(id: number): Promise<PropertyDetail | null> {
    try {
      const resp = await this.http.post<{ data: PropertyDetail }>("/v2/PropertyDetail", { id });
      return resp.data.data ?? null;
    } catch (err: any) {
      console.error(`❌ PropertyDetail (by ID) error: ${err.message}`);
      return null;
    }
  }

  /**
   * Validate that the returned canonical address matches the input.
   */
  private validateAddressMatch(
      input: { house?: string; street?: string; zip?: string },
      returned?: { house?: string | null; street?: string | null; streetType?: string | null; zip?: string | null }
  ): boolean {
    if (!returned) return false;

    const normalize = (s: string | null | undefined) =>
        s ? s.toLowerCase().replace(/\s+/g, " ").trim() : "";

    const returnedStreetFull = [returned.street, returned.streetType].filter(Boolean).join(" ").trim();

    const sameHouse = normalize(input.house) === normalize(returned.house);
    const sameZip = normalize(input.zip) === normalize(returned.zip);
    const sameStreet =
        normalize(input.street) === normalize(returnedStreetFull) ||
        normalize(input.street).includes(normalize(returnedStreetFull)) ||
        normalize(returnedStreetFull).includes(normalize(input.street));

    const match = sameHouse && sameZip && sameStreet;

    if (!match) {
      console.warn("🔍 Address mismatch debug:", {
        input,
        returned: returnedStreetFull,
        comparison: { sameHouse, sameStreet, sameZip },
      });
    }

    return match;
  }

  /**
   * Main enrichment function: prefer PropertyDetail-by-address,
   * fallback to PropertySearch only if necessary.
   */
  public async getEnrichmentDataByAddress(addressString: string): Promise<EnrichmentResult | null> {
    const parsed = this.parseAddress(addressString);
    if (!parsed) {
      console.warn(`⚠️ Could not parse address: ${addressString}`);
      return null;
    }

    // 1️⃣ Try deterministic PropertyDetail-by-address
    const detail = await this.getPropertyDetailByAddress(parsed);
    if (detail?.propertyInfo?.address) {
      const match = this.validateAddressMatch(parsed, detail.propertyInfo.address);
      if (!match) {
        console.warn(`⚠️ ADDRESS_MISMATCH for: ${addressString}`);
        return {
          ownerName: null,
          isActiveListed: false,
          lastSalePrice: null,
          lastSoldDate: null,
          mortgageAmount: null,
          foreclosureActive: false,
          disqualify: true,
          disqualifyReasons: ["ADDRESS_MISMATCH"],
        };
      }
      return this.mapToEnrichment(detail);
    }

    // 2️⃣ Fallback: use PropertySearch → PropertyDetail(by id)
    const propertyId = await this.findPropertyIdByAddress(addressString);
    if (!propertyId) {
      console.warn(`⚠️ No property ID found for: ${addressString}`);
      return null;
    }

    const fallbackDetail = await this.getPropertyDetailById(propertyId);
    if (!fallbackDetail) {
      console.warn(`⚠️ No property detail found for ID ${propertyId}`);
      return null;
    }

    return this.mapToEnrichment(fallbackDetail);
  }

  /**
   * Simple address parser — splits common U.S. address format.
   */
  private parseAddress(address: string): {
    house: string;
    street: string;
    city: string;
    state: string;
    zip: string;
  } | null {
    try {
      const parts = address.split(",").map((s) => s.trim());
      const [line1, city, stateZip] = parts;
      if (!line1) return null;
      const [house, ...streetParts] = line1.split(" ");
      const street = streetParts.join(" ").trim();
      const [state, zip] = stateZip?.split(" ") ?? [];
      return { house, street, city, state, zip };
    } catch {
      return null;
    }
  }

  /**
   * Map the PropertyDetail into the app’s EnrichmentResult structure.
   */
  private mapToEnrichment(detail: PropertyDetail): EnrichmentResult {
    const ownerName = detail.ownerInfo?.owner1FullName ?? detail.ownerInfo?.owner2FullName ?? null;

    const isActiveListed = detail.mlsActive === "true";
    const lastSalePrice = detail.lastSale?.saleAmount ?? null;
    const lastSoldDate = detail.lastSale?.saleDate ?? null;

    const openMortgage =
        (detail.mortgageHistory ?? []).find((m) => m.open === true) ?? null;
    const mortgageAmount = openMortgage?.amount ?? null;

    const foreclosureActive = (detail.foreclosureInfo ?? []).some((f) => f.active === true);

    return {
      ownerName,
      isActiveListed,
      lastSalePrice,
      lastSoldDate,
      mortgageAmount,
      foreclosureActive,
      disqualify: false,
      disqualifyReasons: [],
    };
  }
}