import { mock, MockProxy } from "jest-mock-extended";
import { RealEstateApiDao } from "../../../data/RealEstateApiDao";
import { RealEstateApiPropertySearchResult } from "../../../types/RealEstateApi";
import { LlmClient } from "../../llm/LlmClient";
import { LlmClientResolver } from "../../llm/LlmClientResolver";
import { LlmModelSettingsService } from "../../llm/LlmModelSettingsService";
import { CompsSelectionEngine } from "../CompsSelectionEngine";
import { CompsSelectionPromptService } from "../CompsSelectionPromptService";
import { CompsSettingsService } from "../CompsSettingsService";
import { DEFAULT_COMP_PARAMS } from "../CompsTypes";

/**
 * JAK-164 — the SELECTION ENGINE orchestration. Proves the real /v2/PropertySearch
 * radius pool is the primary path, the LLM chooses ids (with a deterministic
 * fallback + a legacy-cluster fallback), and the JAK-164-addendum data-safety holds
 * (no subject price/date leak; a comp with no own price is dropped).
 */

const TARGET = "358 Fernandina St NW, Palm Bay, FL 32907";
const NOW = new Date("2026-07-06T00:00:00Z");

const SUBJECT_RECORD: RealEstateApiPropertySearchResult = {
  id: "25599529",
  address: { house: "358", street: "Fernandina St Nw", city: "Palm Bay", state: "FL", zip: "32907", county: "Brevard County", fips: "12009" },
  latitude: 28.0124,
  longitude: -80.6795,
  propertyType: "SFR",
  landUse: "Residential",
  squareFeet: 2253,
  bedrooms: 4,
  bathrooms: 3,
  yearBuilt: 2004,
  lastSaleAmount: 844000,
  lastSaleDate: "2025-05-01",
  estimatedValue: 850000,
};

function cand(id: string, over: Partial<RealEstateApiPropertySearchResult> = {}): RealEstateApiPropertySearchResult {
  return {
    id,
    address: { house: id, street: "Fernandina St Nw", city: "Palm Bay", state: "FL", zip: "32907", county: "Brevard County", fips: "12009" },
    latitude: 28.0130,
    longitude: -80.6799,
    propertyType: "SFR",
    landUse: "Residential",
    bedrooms: 4,
    bathrooms: 3,
    squareFeet: 2200,
    lotSquareFeet: 10000,
    yearBuilt: 2003,
    lastSaleAmount: 430000,
    lastSaleDate: "2026-05-15",
    ...over,
  };
}

describe("CompsSelectionEngine.buildComps", () => {
  let dao: MockProxy<RealEstateApiDao>;
  let settings: MockProxy<CompsSettingsService>;
  let selectionPrompt: MockProxy<CompsSelectionPromptService>;
  let llmResolver: MockProxy<LlmClientResolver>;
  let modelSettings: MockProxy<LlmModelSettingsService>;
  let llm: MockProxy<LlmClient>;
  let engine: CompsSelectionEngine;

  beforeEach(() => {
    dao = mock<RealEstateApiDao>();
    settings = mock<CompsSettingsService>();
    selectionPrompt = mock<CompsSelectionPromptService>();
    llmResolver = mock<LlmClientResolver>();
    modelSettings = mock<LlmModelSettingsService>();
    llm = mock<LlmClient>();

    settings.poolParams.mockResolvedValue({ radiusMiles: 10, maxDaysBack: 365, maxCandidates: 50 });
    selectionPrompt.getEffectivePrompt.mockResolvedValue("Select the strongest comps.");
    modelSettings.getEffectiveSelection.mockResolvedValue({ provider: "openai", model: "gpt-4o" });
    llmResolver.resolve.mockReturnValue(llm);
    dao.searchPropertyByAddress.mockResolvedValue(SUBJECT_RECORD);

    engine = new CompsSelectionEngine(dao, settings, selectionPrompt, llmResolver, modelSettings);
  });

  it("fetches the radius pool with the subject's coords + pool params (sold-filter derived from days back)", async () => {
    Object.assign(llm, { isAvailable: false });
    dao.getCompCandidatesByRadius.mockResolvedValue([cand("a"), cand("b")]);

    await engine.buildComps({ target: TARGET, params: DEFAULT_COMP_PARAMS, now: NOW });

    expect(dao.getCompCandidatesByRadius).toHaveBeenCalledWith({
      latitude: 28.0124,
      longitude: -80.6795,
      propertyType: "SFR",
      radiusMiles: 10,
      soldSinceIso: "2025-07-06", // NOW minus 365 days
      maxCandidates: 50,
    });
  });

  it("uses the DETERMINISTIC selection when the LLM is unconfigured", async () => {
    Object.assign(llm, { isAvailable: false });
    dao.getCompCandidatesByRadius.mockResolvedValue([cand("a"), cand("b", { latitude: 28.05 })]);

    const result = await engine.buildComps({ target: TARGET, params: DEFAULT_COMP_PARAMS, now: NOW });

    expect(result.source).toBe("radius");
    expect(result.selectionMode).toBe("deterministic");
    expect(result.data.comps.length).toBeGreaterThanOrEqual(1);
    expect(llm.generateStructured).not.toHaveBeenCalled();
  });

  it("lets the LLM CHOOSE ids from the usable pool, then maps them with code-derived numbers", async () => {
    Object.assign(llm, { isAvailable: true });
    dao.getCompCandidatesByRadius.mockResolvedValue([cand("a"), cand("b"), cand("c")]);
    llm.generateStructured.mockResolvedValue(JSON.stringify({ selected: ["c", "a"] }));

    const result = await engine.buildComps({ target: TARGET, params: DEFAULT_COMP_PARAMS, now: NOW });

    expect(result.selectionMode).toBe("llm");
    expect(result.record).toMatchObject({ source: "radius" });
    // The two chosen comps come back, each with its OWN price (430000), never the subject's.
    expect(result.data.comps).toHaveLength(2);
    result.data.comps.forEach((c) => {
      expect(c.salePrice).toBe(430000);
      expect(c.salePrice).not.toBe(844000);
    });
  });

  it("falls back to the DETERMINISTIC selection when the LLM call throws", async () => {
    Object.assign(llm, { isAvailable: true });
    dao.getCompCandidatesByRadius.mockResolvedValue([cand("a")]);
    llm.generateStructured.mockRejectedValue(new Error("timeout"));

    const result = await engine.buildComps({ target: TARGET, params: DEFAULT_COMP_PARAMS, now: NOW });

    expect(result.selectionMode).toBe("deterministic");
    expect(result.data.comps).toHaveLength(1);
  });

  it("falls back to the legacy CLUSTER when the radius pool is empty", async () => {
    Object.assign(llm, { isAvailable: false });
    dao.getCompCandidatesByRadius.mockResolvedValue([]);
    dao.getCompsByAddress.mockResolvedValue({
      comps: [{ address: "123 Cluster Way", lastSaleAmount: 500000, bedrooms: 4, bathrooms: 3, squareFeet: 2200 }],
      subject: { bedrooms: 4, bathrooms: 3, squareFeet: 2253, latitude: 28.0124, longitude: -80.6795 },
    } as never);

    const result = await engine.buildComps({ target: TARGET, params: DEFAULT_COMP_PARAMS, now: NOW });

    expect(result.source).toBe("cluster");
    expect(dao.getCompsByAddress).toHaveBeenCalled();
    expect(result.data.comps.length).toBeGreaterThanOrEqual(1);
  });

  it("falls back to the cluster when the subject has no coordinates for a radius search", async () => {
    Object.assign(llm, { isAvailable: false });
    dao.searchPropertyByAddress.mockResolvedValue({ ...SUBJECT_RECORD, latitude: null, longitude: null });
    dao.getCompsByAddress.mockResolvedValue({ comps: [], subject: {} } as never);

    const result = await engine.buildComps({ target: TARGET, params: DEFAULT_COMP_PARAMS, now: NOW });

    expect(dao.getCompCandidatesByRadius).not.toHaveBeenCalled();
    expect(dao.getCompsByAddress).toHaveBeenCalled();
    expect(result.source).toBe("none");
  });

  it("ADDENDUM: drops candidates with no OWN price and never leaks the subject's price/date onto a comp", async () => {
    Object.assign(llm, { isAvailable: false });
    dao.getCompCandidatesByRadius.mockResolvedValue([
      cand("priced", { lastSaleAmount: 430000, lastSaleDate: "2026-05-15" }),
      cand("noprice", { lastSaleAmount: 0, mlsSoldPrice: null }),
    ]);

    const result = await engine.buildComps({ target: TARGET, params: DEFAULT_COMP_PARAMS, now: NOW });

    expect(result.data.comps).toHaveLength(1);
    expect(result.data.comps[0]!.salePrice).toBe(430000);
    // The subject's own last-sold ($844k / 2025-05-01) NEVER appears on a comp.
    result.data.comps.forEach((c) => {
      expect(c.salePrice).not.toBe(844000);
      expect(c.saleDate).not.toBe("05/01/2025");
    });
  });

  it("ADDENDUM: renders days on market when both MLS dates exist (per spec)", async () => {
    Object.assign(llm, { isAvailable: false });
    dao.getCompCandidatesByRadius.mockResolvedValue([
      cand("mls", { mlsSoldPrice: 455000, mlsLastSaleDate: "2026-06-01", mlsListingDate: "2026-05-02" }),
    ]);

    const result = await engine.buildComps({ target: TARGET, params: DEFAULT_COMP_PARAMS, now: NOW });

    expect(result.data.comps[0]!.daysOnMarket).toBe(30);
    expect(result.data.comps[0]!.pricePerSquareFoot).toBe(Math.round(455000 / 2200));
  });
});
