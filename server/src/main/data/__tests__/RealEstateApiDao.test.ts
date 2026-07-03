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
      // JAK-136: dev NEVER hits the paid /v2/SkipTrace — returns no owner/PII.
      expect(await dao.skipTraceByAddress(ADDRESS)).toBeNull();
      expect(post).not.toHaveBeenCalled();
    });
  });

  describe("prod / staging (real actions ON)", () => {
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

    it("hits the real /v2/SkipTrace endpoint in prod with the parsed address parts", async () => {
      post.mockResolvedValue({
        data: { data: { match: true, output: { identity: { name: "Owner One" } } } },
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
      expect(result?.output?.identity?.name).toBe("Owner One");
    });
  });
});
