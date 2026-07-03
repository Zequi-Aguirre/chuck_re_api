// server/src/main/data/RealEstateApiDao.ts

import axios, { AxiosInstance, CreateAxiosDefaults } from "axios";
import { injectable } from "tsyringe";
import { EnvConfig } from "../config/envConfig.ts";
import { ExternalActionGuard } from "../safety/ExternalActionGuard.ts";
import { EnrichmentResult } from "../types/LeadEnrichment.ts";
import {
  MailerEnrichmentResponse,
  RealEstateApiPropertyCompsResponse,
  RealEstateApiPropertyDetail,
  RealEstateApiPropertyDetailResponse,
  RealEstateApiPropertySearchResponse,
  RealEstateApiPropertySearchResult,
  RealEstateApiSkipTraceResponse,
  RealEstateApiSkipTraceResult,
  RealEstateApiAddress,
} from "../types/RealEstateApi.ts";

/**
 * The API-facing comps parameters the DAO passes through to /v3/PropertyComps
 * (JAK-137). The caller (the comps specialist) resolves + clamps these from the
 * admin defaults and any texter overrides; the bed/bath/sqft tolerance filters are
 * applied downstream against the returned subject, so only the three query knobs
 * the endpoint takes pre-lookup live here.
 */
export interface RealEstateApiCompsParams {
  /** Search radius in miles → max_radius_miles. */
  radiusMiles: number;
  /** Max number of comps to return → max_results. */
  count: number;
  /** Recency window in months → max_days_back (≈ months * 30). */
  monthsBack: number;
}

@injectable()
export class RealEstateApiDao {
  private readonly http: AxiosInstance;

  /**
   * Dev-safety mocks (JAK-110). These are what the paid endpoints return off
   * prod/staging instead of spending a real credit — deterministic "no match"
   * payloads (never fabricated owner/PII), so dev flows resolve to "no property
   * found" and no lookup is billed.
   */
  private static readonly DEV_MOCK_SEARCH: RealEstateApiPropertySearchResponse = { data: [] };
  private static readonly DEV_MOCK_DETAIL: RealEstateApiPropertyDetailResponse = {
    data: { mlsActive: false },
  };
  /**
   * Skip-trace dev mock (JAK-136): a deterministic NO-MATCH (never a fabricated
   * owner/phone/PII), so off-prod skip-trace flows resolve to "no contact found"
   * and no credit is spent — the SAME dev-safety boundary as the property lookups.
   */
  private static readonly DEV_MOCK_SKIPTRACE: RealEstateApiSkipTraceResponse = { data: null };
  /**
   * Comps dev mock (JAK-137): a deterministic EMPTY result (never fabricated
   * comparable sales), so off-prod comps flows resolve to "no comparable sales
   * found" and no credit is spent — the SAME dev-safety boundary as the property
   * and skip-trace lookups.
   */
  private static readonly DEV_MOCK_COMPS: RealEstateApiPropertyCompsResponse = { comps: [] };

  constructor(
    private readonly env: EnvConfig,
    private readonly guard: ExternalActionGuard
  ) {
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
   * The SINGLE paid-lookup chokepoint (SPEC §8 / JAK-110). Every billable
   * PropertySearch / PropertyDetail call funnels through here, so dev-safety is
   * enforced in exactly one place: off prod/staging we never spend — the call is
   * echoed and a deterministic `devMock` is returned instead of hitting the API.
   * This is an ENV GATE (via {@link ExternalActionGuard}), not a runtime toggle.
   */
  private async paidPost<T>(url: string, body: object, devMock: T): Promise<T> {
    if (!this.guard.liveActionsAllowed) {
      this.guard.echoSkipped("paid RealEstate API lookup", `POST ${url}`);
      return devMock;
    }
    const resp = await this.http.post<T>(url, body);
    return resp.data;
  }

  /**
   * PropertySearch fallback — fuzzy lookup for when parsing or detail lookup fails.
   */
  public async findPropertyIdByAddress(addressString: string): Promise<number | null> {
    try {
      const data = await this.paidPost<RealEstateApiPropertySearchResponse>(
        "/v2/PropertySearch",
        { size: 5, address: addressString },
        RealEstateApiDao.DEV_MOCK_SEARCH
      );

      const first = data.data?.[0];
      const idStr = first?.id;
      const id = typeof idStr === "string" ? Number(idStr) : idStr;

      return id != null && Number.isFinite(id) ? id : null;
    } catch (err: any) {
      console.error(`❌ PropertySearch error: ${err.message}`);
      return null;
    }
  }

  /**
   * PropertySearch summary lookup — returns the top matching property's
   * summary record (or null). Used by the SMS assistant core path to build a
   * reply directly from a single /v2/PropertySearch call.
   */
  public async searchPropertyByAddress(
    addressString: string
  ): Promise<RealEstateApiPropertySearchResult | null> {
    try {
      const data = await this.paidPost<RealEstateApiPropertySearchResponse>(
        "/v2/PropertySearch",
        { size: 1, address: addressString },
        RealEstateApiDao.DEV_MOCK_SEARCH
      );

      return data.data?.[0] ?? null;
    } catch (err: any) {
      console.error(`❌ PropertySearch error: ${err.message}`);
      return null;
    }
  }

  /**
   * Skip-trace an OWNER by property address (JAK-136) — the /v2/SkipTrace
   * owner/contact lookup that backs the text-Jake skip-trace specialist. Returns
   * the top match record (or null on no match). An optional owner name (carried
   * over from a prior property result in memory) narrows the trace when present.
   *
   * This is a PAID, READ-ONLY endpoint, so it funnels through the SAME
   * {@link paidPost} chokepoint as PropertySearch/PropertyDetail: off prod/staging
   * it NEVER spends — the call is echoed and the deterministic no-match dev mock is
   * returned instead of hitting the provider (dev never spends real credits/$).
   */
  public async skipTraceByAddress(
    addressString: string,
    owner?: { firstName?: string | null; lastName?: string | null }
  ): Promise<RealEstateApiSkipTraceResult | null> {
    try {
      const parsed = this.parseAddress(addressString);
      const body: Record<string, string> = parsed
        ? {
            address: `${parsed.house} ${parsed.street}`.trim(),
            city: parsed.city,
            state: parsed.state,
            zip: parsed.zip,
          }
        : { address: addressString };
      const first = owner?.firstName?.trim();
      const last = owner?.lastName?.trim();
      if (first) body.first_name = first;
      if (last) body.last_name = last;

      const data = await this.paidPost<RealEstateApiSkipTraceResponse>(
        "/v2/SkipTrace",
        body,
        RealEstateApiDao.DEV_MOCK_SKIPTRACE
      );
      return data.data ?? null;
    } catch (err: any) {
      console.error(`❌ SkipTrace error: ${err.message}`);
      return null;
    }
  }

  /**
   * Pull COMPARABLE SALES for a property address (JAK-137) — the /v3/PropertyComps
   * comparables/CMA lookup that backs the text-Jake comps specialist. Returns the
   * raw response (comps + subject + AVM range) or null on failure. The three query
   * knobs map to the endpoint's documented params: radius → max_radius_miles,
   * count → max_results, timeframe → max_days_back (months × 30). The bed/bath/sqft
   * tolerance filters are applied downstream against the returned subject.
   *
   * v2/PropertyComps was deprecated 2026-01-01, so this uses the current
   * /v3/PropertyComps endpoint. It is a PAID, READ-ONLY lookup, so it funnels
   * through the SAME {@link paidPost} chokepoint as PropertySearch/PropertyDetail/
   * SkipTrace: off prod/staging it NEVER spends — the call is echoed and the
   * deterministic empty dev mock is returned instead of hitting the provider.
   */
  public async getCompsByAddress(
    addressString: string,
    params: RealEstateApiCompsParams
  ): Promise<RealEstateApiPropertyCompsResponse | null> {
    try {
      const parsed = this.parseAddress(addressString);
      const address = parsed
        ? `${parsed.house} ${parsed.street}, ${parsed.city}, ${parsed.state} ${parsed.zip}`.trim()
        : addressString;
      const body: Record<string, string | number> = {
        address,
        max_radius_miles: params.radiusMiles,
        max_results: params.count,
        max_days_back: Math.round(params.monthsBack * 30),
      };

      return await this.paidPost<RealEstateApiPropertyCompsResponse>(
        "/v3/PropertyComps",
        body,
        RealEstateApiDao.DEV_MOCK_COMPS
      );
    } catch (err: any) {
      console.error(`❌ PropertyComps error: ${err.message}`);
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
  }): Promise<RealEstateApiPropertyDetail | null> {
    try {
      const data = await this.paidPost<RealEstateApiPropertyDetailResponse>(
        "/v2/PropertyDetail",
        parts,
        RealEstateApiDao.DEV_MOCK_DETAIL
      );
      return data.data ?? null;
    } catch (err: any) {
      console.error(`❌ PropertyDetail (by address) error: ${err.message}`);
      return null;
    }
  }

  /**
   * Fallback: PropertyDetail by property ID.
   */
  public async getPropertyDetailById(id: number): Promise<RealEstateApiPropertyDetail | null> {
    try {
      const data = await this.paidPost<RealEstateApiPropertyDetailResponse>(
        "/v2/PropertyDetail",
        { id },
        RealEstateApiDao.DEV_MOCK_DETAIL
      );
      return data.data ?? null;
    } catch (err: any) {
      console.error(`❌ PropertyDetail (by ID) error: ${err.message}`);
      return null;
    }
  }

  /**
   * Validate that the returned canonical address matches the input.
   * This prevents PropertySearch fallback from returning a "nearby" property.
   */
  private validateAddressMatch(
      input: { house?: string; street?: string; zip?: string },
      returned?: RealEstateApiAddress
  ): boolean {
    if (!returned) return false;

    const normalize = (s: string | null | undefined) => (s ? s.toLowerCase().replace(/\s+/g, " ").trim() : "");

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
   *
   * Returns your internal EnrichmentResult type (used by your queue worker flow).
   */
  public async getEnrichmentDataByAddress(addressString: string): Promise<EnrichmentResult | null> {
    const parsed = this.parseAddress(addressString);
    if (!parsed) {
      console.warn(`⚠️ Could not parse address: ${addressString}`);
      return null;
    }

    // 1) Deterministic PropertyDetail-by-address
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

    // 2) Fallback: PropertySearch -> PropertyDetail(by id)
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
   * Mailer TracerBullet function:
   * Same lookup strategy as enrichment, but returns trimmed MailerEnrichmentResponse.
   */
  public async getMailerEnrichmentByAddress(addressString: string): Promise<MailerEnrichmentResponse | null> {
    const parsed = this.parseAddress(addressString);
    if (!parsed) {
      console.warn(`⚠️ Could not parse address: ${addressString}`);
      return null;
    }

    // 1) Deterministic PropertyDetail-by-address
    const detail = await this.getPropertyDetailByAddress(parsed);
    console.log("ℹ️ Mailer enrichment detail (by address):", detail);

    if (detail?.propertyInfo?.address) {
      const match = this.validateAddressMatch(parsed, detail.propertyInfo.address);
      if (!match) {
        // For mailer use-case, mismatch means "do not trust result"
        return {
          propertyAddress: {
            label: null,
            house: null,
            street: null,
            city: null,
            state: null,
            zip: null,
          },
          owner: { owner1FullName: null, owner2FullName: null, type: null },
          mailingAddress: { label: null, address: null, city: null, state: null, zip: null },
          propertyBasics: { type: null, beds: null, baths: null, sqft: null, lotSqft: null, yearBuilt: null },
          mls: { active: false, sold: null, listingPrice: null, listingDate: null },
          mortgage: { hasOpen: false, openCount: 0, openTotal: null },
          foreclosure: { active: false },
          audit: { propertyId: null },
        };
      }

      return this.mapToMailer(detail);
    }

    // 2) Fallback: PropertySearch -> PropertyDetail(by id)
    const propertyId = await this.findPropertyIdByAddress(addressString);
    if (!propertyId) {
      return null;
    }

    const fallbackDetail = await this.getPropertyDetailById(propertyId);
    if (!fallbackDetail) {
      return null;
    }

    return this.mapToMailer(fallbackDetail);
  }

  /**
   * Simple address parser — splits common U.S. address format:
   * "7640 Sunset Strip, Sunrise, FL 33322"
   */
  private parseAddress(address: string): {
    house: string;
    street: string;
    city: string;
    state: string;
    zip: string;
  } | null {
    try {
      // Expect: "102 Southwind Dr, Kathleen Georgia 31047"
      // Also tolerate: "102 Southwind Dr, Kathleen, Georgia 31047"
      const raw = address.trim().replace(/\s+/g, " ");
      const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);

      if (parts.length < 2) return null;

      const line1 = parts[0]!;
      const tail = parts.slice(1).join(" "); // handles optional comma before state

      // line1 => "102 Southwind Dr"
      const line1Match = line1.match(/^(\d+)\s+(.+)$/);
      if (!line1Match) return null;

      const house = line1Match[1]!.trim();
      const street = line1Match[2]!.trim();

      // tail => "Kathleen Georgia 31047"
      // City may be multi-word. State may be full or 2-letter. Zip is 5-digit.
      const zipMatch = tail.match(/\b(\d{5})(?:-\d{4})?\b$/);
      if (!zipMatch) return null;

      const zip = zipMatch[1]!;
      const beforeZip = tail.slice(0, zipMatch.index).trim();

      // Try: "... <State>" at end, where state can be "Georgia" or "GA"
      const stateMatch = beforeZip.match(/\b([A-Za-z]{2,})$/);
      if (!stateMatch) return null;

      const stateRaw = stateMatch[1]!.trim();
      const city = beforeZip.slice(0, stateMatch.index).trim();

      if (!city) return null;

      const state = this.toStateCode(stateRaw);
      if (!state) return null;

      return { house, street, city, state, zip };
    } catch {
      return null;
    }
  }

  private toStateCode(input: string): string | null {
    const s = input.trim().toLowerCase().replace(/\./g, "");

    // Already a 2-letter code
    if (/^[a-z]{2}$/.test(s)) return s.toUpperCase();

    const map: Record<string, string> = {
      alabama: "AL",
      alaska: "AK",
      arizona: "AZ",
      arkansas: "AR",
      california: "CA",
      colorado: "CO",
      connecticut: "CT",
      delaware: "DE",
      florida: "FL",
      georgia: "GA",
      hawaii: "HI",
      idaho: "ID",
      illinois: "IL",
      indiana: "IN",
      iowa: "IA",
      kansas: "KS",
      kentucky: "KY",
      louisiana: "LA",
      maine: "ME",
      maryland: "MD",
      massachusetts: "MA",
      michigan: "MI",
      minnesota: "MN",
      mississippi: "MS",
      missouri: "MO",
      montana: "MT",
      nebraska: "NE",
      nevada: "NV",
      "new hampshire": "NH",
      "new jersey": "NJ",
      "new mexico": "NM",
      "new york": "NY",
      "north carolina": "NC",
      "north dakota": "ND",
      ohio: "OH",
      oklahoma: "OK",
      oregon: "OR",
      pennsylvania: "PA",
      "rhode island": "RI",
      "south carolina": "SC",
      "south dakota": "SD",
      tennessee: "TN",
      texas: "TX",
      utah: "UT",
      vermont: "VT",
      virginia: "VA",
      washington: "WA",
      "west virginia": "WV",
      wisconsin: "WI",
      wyoming: "WY",
      "district of columbia": "DC",
    };

    // Handle multi-word states: we already extract the last token, but your input is "Georgia".
    // If you later pass "New York", the parser needs to capture it differently.
    // For now: support single-word full names + 2-letter codes, per your stated format.
    return map[s] ?? null;
  }

  /**
   * Map the PropertyDetail into the app’s EnrichmentResult structure.
   */
  private mapToEnrichment(detail: RealEstateApiPropertyDetail): EnrichmentResult {
    const ownerName = detail.ownerInfo?.owner1FullName ?? detail.ownerInfo?.owner2FullName ?? null;
    const isActiveListed = Boolean(detail.mlsActive);
    const lastSalePrice = detail.lastSale?.saleAmount ?? null;
    const lastSoldDate = detail.lastSale?.saleDate ?? null;

    const openMortgage = (detail.mortgageHistory ?? []).find((m) => m.open === true) ?? null;
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

  /**
   * Map PropertyDetail -> MailerEnrichmentResponse (best-effort, null-safe).
   * Mailing address field locations vary by provider, so we try multiple likely paths.
   */
  private mapToMailer(detail: RealEstateApiPropertyDetail): MailerEnrichmentResponse {
    const addr = detail.propertyInfo?.address;

    // ✅ Correct: your provider returns the mailing address here
    const mailing =
        detail.ownerInfo?.mailAddress ??
        detail.taxMailingAddress ??
        detail.mailingAddress ??
        detail.propertyInfo?.mailingAddress ??
        null;

    const openMortgages = (detail.mortgageHistory ?? []).filter((m) => m?.open === true);
    const openCount = openMortgages.length;

    const openTotal = openCount
        ? openMortgages.reduce((sum, m) => {
          const amt = typeof m?.amount === "number" ? m.amount : 0;
          return sum + amt;
        }, 0)
        : null;

    const foreclosureActive = (detail.foreclosureInfo ?? []).some((f) => f?.active === true);

    const basicsTop = detail.propertyBasics ?? null;
    const info = detail.propertyInfo ?? null;

    const propertyIdRaw = detail.propertyId ?? detail.id ?? null;
    const propertyId =
        typeof propertyIdRaw === "string"
            ? Number(propertyIdRaw)
            : typeof propertyIdRaw === "number"
                ? propertyIdRaw
                : null;

    return {
      propertyAddress: {
        label: addr?.label ?? null,
        house: addr?.house ?? null,
        street: addr?.street ?? null,
        city: addr?.city ?? null,
        state: addr?.state ?? null,
        zip: addr?.zip ?? null,
      },
      owner: {
        owner1FullName: detail.ownerInfo?.owner1FullName ?? null,
        owner2FullName: detail.ownerInfo?.owner2FullName ?? null,
        type: detail.ownerInfo?.ownerType ?? null,
      },
      mailingAddress: {
        label: mailing?.label ?? null,
        address: mailing?.address ?? null,
        city: mailing?.city ?? null,
        state: mailing?.state ?? null,
        zip: mailing?.zip ?? null,
      },
      propertyBasics: {
        type: basicsTop?.propertyType ?? info?.propertyType ?? null,
        beds: basicsTop?.bedrooms ?? info?.bedrooms ?? null,
        baths: basicsTop?.bathrooms ?? info?.bathrooms ?? null,

        // ✅ Correct fields from your payload
        sqft:
            basicsTop?.livingArea ??
            (info as any)?.livingSquareFeet ??
            (info as any)?.livingArea ??
            null,

        lotSqft:
            basicsTop?.lotSize ??
            (info as any)?.lotSquareFeet ??
            (info as any)?.lotSize ??
            null,

        yearBuilt: basicsTop?.yearBuilt ?? info?.yearBuilt ?? null,
      },
      mls: {
        active: Boolean(detail.mlsActive),
        sold: detail.mlsSold ?? null,
        listingPrice: detail.mlsListingPrice ?? null,
        listingDate: detail.mlsListingDate ?? null,
      },
      mortgage: {
        hasOpen: openCount > 0,
        openCount,
        openTotal,
      },
      foreclosure: {
        active: foreclosureActive,
      },
      audit: {
        propertyId: Number.isFinite(propertyId as number) ? (propertyId as number) : null,
      },
      rawData: JSON.stringify(detail) || null,
    };
  }
}