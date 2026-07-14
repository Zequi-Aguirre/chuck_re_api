import axios from "axios";
import { RealEstateApiDao } from "../RealEstateApiDao";
import { EnvConfig } from "../../config/envConfig";
import { ExternalActionGuard } from "../../safety/ExternalActionGuard";

jest.mock("axios");

/**
 * JAK-110 dev-safety proof for the paid RealEstate API: off prod/staging, no
 * PropertySearch/PropertyDetail call is ever made (no credit is spent); on
 * prod/staging the real transport is hit exactly once per lookup.
 */
describe("RealEstateApiDao — paid-lookup dev safety (JAK-110)", () => {
  const post = jest.fn();

  const env = {
    realEstateBaseUrl: "https://api.realestate.example.com",
    realEstateApiKey: "test-key-not-real",
  } as unknown as EnvConfig;

  const guardWith = (live: boolean): ExternalActionGuard =>
    ({ liveActionsAllowed: live, echoSkipped: () => {} } as unknown as ExternalActionGuard);

  beforeEach(() => {
    post.mockReset();
    (axios.create as jest.Mock).mockReturnValue({ post });
  });

  const daoFor = (live: boolean) => new RealEstateApiDao(env, guardWith(live));

  const ADDRESS = "102 Southwind Dr, Kathleen, Georgia 31047";

  describe("dev (real actions OFF)", () => {
    it("does NOT call the paid API and returns no match (no spend)", async () => {
      const dao = daoFor(false);

      const result = await dao.getEnrichmentDataByAddress(ADDRESS);

      expect(post).not.toHaveBeenCalled();
      expect(result).toBeNull();
    });

    it("mocks a bare PropertyDetail lookup with a deterministic no-match (no transport)", async () => {
      const dao = daoFor(false);
      // Returns the deterministic dev mock (never fabricated PII) — the point is
      // that the paid endpoint is never hit.
      expect(await dao.getPropertyDetailByAddress({
        house: "102", street: "Southwind Dr", city: "Kathleen", state: "GA", zip: "31047",
      })).toEqual({ mlsActive: false });
      expect(post).not.toHaveBeenCalled();
    });

    it("mocks a PropertySearch lookup (no transport)", async () => {
      const dao = daoFor(false);
      expect(await dao.searchPropertyByAddress(ADDRESS)).toBeNull();
      expect(post).not.toHaveBeenCalled();
    });

    it("mocks a SkipTrace lookup with a deterministic no-match (no transport, no spend)", async () => {
      const dao = daoFor(false);
      // JAK-136/144: dev NEVER hits the paid /v2/SkipTrace — returns no owner/PII.
      expect(await dao.skipTraceByAddress(ADDRESS)).toEqual({ persons: [], match: false });
      expect(post).not.toHaveBeenCalled();
    });

    it("mocks a PropertyComps lookup with a deterministic EMPTY result (no transport, no spend)", async () => {
      const dao = daoFor(false);
      // JAK-137/144: dev NEVER hits the paid comps lookup — returns no comps.
      const result = await dao.getCompsByAddress(ADDRESS, { radiusMiles: 1, count: 5, monthsBack: 12 });
      expect(result?.comps).toEqual([]);
      expect(post).not.toHaveBeenCalled();
    });

    it("JAK-164: the radius comp-candidate pool is dev-mocked EMPTY (no transport, no spend)", async () => {
      const dao = daoFor(false);
      const result = await dao.getCompCandidatesByRadius({
        latitude: 28.0124,
        longitude: -80.6795,
        propertyType: "SFR",
        radiusMiles: 10,
        soldSinceIso: "2025-07-06",
        maxCandidates: 50,
      });
      expect(result).toEqual([]);
      expect(post).not.toHaveBeenCalled();
    });
  });

  describe("prod / staging (real actions ON)", () => {
    it("JAK-164: builds the /v2/PropertySearch geo-radius sold-comp pool body + returns the records", async () => {
      post.mockResolvedValue({
        data: { data: [{ id: "c1", latitude: 28.01, longitude: -80.68 }], resultCount: 6695 },
      });
      const dao = daoFor(true);

      const records = await dao.getCompCandidatesByRadius({
        latitude: 28.0124,
        longitude: -80.6795,
        propertyType: "SFR",
        radiusMiles: 10,
        soldSinceIso: "2025-07-06",
        maxCandidates: 50,
      });

      expect(post).toHaveBeenCalledTimes(1);
      expect(post.mock.calls[0][0]).toBe("/v2/PropertySearch");
      // The geo-radius + sold filter + type + size go in the body (NOT PropertyDetail).
      expect(post.mock.calls[0][1]).toMatchObject({
        size: 50,
        latitude: 28.0124,
        longitude: -80.6795,
        radius: 10,
        last_sale_date_min: "2025-07-06",
        property_type: "SFR",
      });
      expect(records).toHaveLength(1);
      expect(records[0]!.id).toBe("c1");
    });

    it("hits the real PropertyDetail endpoint in prod", async () => {
      post.mockResolvedValue({ data: { data: { mlsActive: true } } });
      const dao = daoFor(true);

      const detail = await dao.getPropertyDetailByAddress({
        house: "102", street: "Southwind Dr", city: "Kathleen", state: "GA", zip: "31047",
      });

      expect(post).toHaveBeenCalledTimes(1);
      expect(post.mock.calls[0][0]).toBe("/v2/PropertyDetail");
      expect(detail?.mlsActive).toBe(true);
    });

    it("hits the real PropertySearch endpoint in staging", async () => {
      post.mockResolvedValue({ data: { data: [{ id: "42" }] } });
      const dao = daoFor(true);

      const id = await dao.findPropertyIdByAddress(ADDRESS);

      expect(post).toHaveBeenCalledTimes(1);
      expect(post.mock.calls[0][0]).toBe("/v2/PropertySearch");
      expect(id).toBe(42);
    });

    it("hits the real /v2/SkipTrace endpoint in prod and parses the top-level persons[] (JAK-144)", async () => {
      // JAK-144: the live provider returns matches at the TOP LEVEL under
      // `persons[]` (NOT wrapped under `data`). Representative (fake) shape.
      post.mockResolvedValue({
        data: {
          match: true,
          persons: [
            {
              fullName: "Owner One",
              phones: [{ phone: "5615550100", phoneType: "W" }],
              emails: ["owner.one@example.com"],
              address: { streetAddress: "102 Southwind Dr", city: "Kathleen", state: "GA", zip: "31047" },
            },
          ],
        },
      });
      const dao = daoFor(true);

      const result = await dao.skipTraceByAddress(ADDRESS);

      expect(post).toHaveBeenCalledTimes(1);
      expect(post.mock.calls[0][0]).toBe("/v2/SkipTrace");
      // The address is parsed into structured params for the trace.
      expect(post.mock.calls[0][1]).toMatchObject({
        address: "102 Southwind Dr",
        city: "Kathleen",
        state: "GA",
        zip: "31047",
      });
      // Parsed from the top-level persons[] (the old `data.data` read got nothing).
      expect(result?.persons?.[0]?.fullName).toBe("Owner One");
      expect(result?.persons?.[0]?.phones?.[0]?.phone).toBe("5615550100");
    });

    it("passes the owner first/last name into the /v2/SkipTrace body (JAK-145)", async () => {
      post.mockResolvedValue({ data: { match: true, persons: [{ fullName: "Owner One" }] } });
      const dao = daoFor(true);

      await dao.skipTraceByAddress(ADDRESS, { firstName: "Homer", lastName: "Simpson" });

      expect(post).toHaveBeenCalledTimes(1);
      expect(post.mock.calls[0][0]).toBe("/v2/SkipTrace");
      // The owner name rides alongside the parsed address so we trace the right person.
      expect(post.mock.calls[0][1]).toMatchObject({
        address: "102 Southwind Dr",
        city: "Kathleen",
        state: "GA",
        zip: "31047",
        first_name: "Homer",
        last_name: "Simpson",
      });
    });

    it("pulls comps via /v2/PropertyDetail(comps:true) and normalizes the response (JAK-144)", async () => {
      // JAK-144: the standalone PropertyComps endpoints are 401 for this key; comps
      // come from PropertyDetail with comps:true, nested under data.comps, with the
      // subject's beds/baths/sqft under propertyInfo and the AVM as estimatedValue.
      post.mockResolvedValue({
        data: {
          data: {
            mlsActive: true,
            estimatedValue: 356000,
            propertyInfo: { bedrooms: 4, bathrooms: 3, livingSquareFeet: 2253 },
            comps: [
              { id: "1", address: { address: "489 Freeman Rd Nw" }, lastSaleAmount: "250000", bedrooms: "4", squareFeet: "2083" },
            ],
          },
        },
      });
      const dao = daoFor(true);

      const result = await dao.getCompsByAddress(ADDRESS, { radiusMiles: 2, count: 4, monthsBack: 6 });

      expect(post).toHaveBeenCalledTimes(1);
      expect(post.mock.calls[0][0]).toBe("/v2/PropertyDetail");
      // Address parts + comps:true (NOT the old max_radius_miles/max_results params).
      expect(post.mock.calls[0][1]).toMatchObject({
        street: "Southwind Dr",
        city: "Kathleen",
        state: "GA",
        zip: "31047",
        comps: true,
      });
      // Normalized: comps lifted from data.comps, AVM from estimatedValue, subject
      // beds/baths/sqft from propertyInfo.
      expect(result?.comps?.length).toBe(1);
      expect((result?.comps?.[0] as any)?.lastSaleAmount).toBe("250000");
      expect(result?.reapiAvm).toBe(356000);
      expect(result?.subject?.bedrooms).toBe(4);
      expect(result?.subject?.squareFeet).toBe(2253);
    });
  });
});
