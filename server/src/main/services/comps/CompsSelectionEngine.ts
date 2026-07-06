import { injectable } from "tsyringe";
import { RealEstateApiDao } from "../../data/RealEstateApiDao";
import { LlmClient } from "../llm/LlmClient";
import { LlmClientResolver } from "../llm/LlmClientResolver";
import { LlmModelSettingsService } from "../llm/LlmModelSettingsService";
import { CompsSelectionPromptService } from "./CompsSelectionPromptService";
import { CompsSettingsService } from "./CompsSettingsService";
import {
  assembleCompsData,
  CompParams,
  CompSaleData,
  CompsData,
  formatCompParams,
} from "./CompsTypes";
import {
  CompCandidate,
  CompsSelectionOptions,
  CompsSubject,
  filterUsable,
  mapCandidate,
  mapSubject,
  SelectedComp,
  selectDeterministic,
  toSelectedComp,
} from "./CompsSelectionTypes";

/** How the comps for one request were produced, for the status note + tests. */
export interface CompsBuildResult {
  /** The verified, formatter-ready comps data (may be empty when nothing is usable). */
  data: CompsData;
  /** A cacheable snapshot of what produced this reply (stored on the comps row). */
  record: unknown;
  /** Which pool the comps came from: the real radius pool, the legacy cluster, or none. */
  source: "radius" | "cluster" | "none";
  /** Whether the LLM or the deterministic rules made the final selection. */
  selectionMode: "llm" | "deterministic" | "none";
  /** How many candidates the radius pool returned (0 for the cluster/none paths). */
  poolSize: number;
  /** How many survived the hard-reject rules (0 for the cluster/none paths). */
  usableSize: number;
}

/**
 * JAK-164 — the Comparable-Sales SELECTION ENGINE. It sits BETWEEN the API and the
 * existing {@link import("./CompsReportWriter").CompsReportWriter} formatter and does
 * the three things Eric asked for:
 *
 *   1. POOL — assemble a REAL up-to-10-mile candidate pool of recent sales via
 *      /v2/PropertySearch (geo-radius + sold filter), NOT the fixed ~1-mile
 *      PropertyDetail cluster and NOT the paid v3/PropertyComps scope. PropertySearch
 *      returns candidates nearest-first, so it naturally "expands outward" only when
 *      close comps are scarce.
 *   2. SELECT — pick the STRONGEST true comps. An admin-editable LLM prompt
 *      ({@link CompsSelectionPromptService}, model-pickable via the JAK-143 layer)
 *      chooses + ranks; a DETERMINISTIC rules engine is both the floor and the
 *      fallback when the LLM is unconfigured/fails. Either way the hard-reject rules
 *      and every numeric field (sale price/date used, PPSF, days on market, distance)
 *      are computed in CODE so they are correct regardless of the LLM.
 *   3. DEGRADE HONESTLY — if the radius pool yields nothing usable (e.g. sparse
 *      prices), fall back to the legacy PropertyDetail cluster; if that is empty too,
 *      return an empty set so the caller charges nothing and the formatter says so.
 *      Never pad with weak/rejected comps.
 *
 * It ALWAYS produces a result object (Jake must always reply). The credit gate,
 * cache/free-reserve, and formatter all live in the caller — unchanged.
 */
@injectable()
export class CompsSelectionEngine {
  private static readonly SELECT_MAX_TOKENS = 700;
  /** Spec: return the best 3 comps when possible, never more than 5. */
  private static readonly TARGET_COMPS = 3;
  private static readonly HARD_CAP = 5;

  private static readonly SELECT_SCHEMA: Record<string, unknown> = {
    type: "object",
    additionalProperties: false,
    properties: {
      selected: {
        type: "array",
        description: "The chosen candidate ids, STRONGEST comp first. Only ids from the provided candidate list. At most 5.",
        items: { type: "string" },
      },
    },
    required: ["selected"],
  };

  constructor(
    private readonly realEstateDao: RealEstateApiDao,
    private readonly settings: CompsSettingsService,
    private readonly selectionPrompt: CompsSelectionPromptService,
    private readonly llmResolver: LlmClientResolver,
    private readonly modelSettings: LlmModelSettingsService
  ) {}

  /**
   * Build the comps for one request: resolve the subject, pull the real radius pool,
   * select the strongest comps (LLM with a deterministic fallback), and assemble the
   * formatter-ready {@link CompsData}. Falls back to the legacy cluster only when the
   * radius path yields nothing usable. `params` carries the texter/admin display
   * knobs (used for the reply's parameter summary); the pool radius/recency come from
   * the {@link CompsSettingsService} pool settings.
   */
  async buildComps(input: { target: string; params: CompParams; now?: Date }): Promise<CompsBuildResult> {
    const { target, params } = input;
    const now = input.now ?? new Date();

    // 1) Resolve the subject via the SAME PropertySearch call the report path uses.
    const rawSubject = await this.realEstateDao.searchPropertyByAddress(target);
    const subject = mapSubject(rawSubject);

    // 2) Only the real radius pool needs the subject's coordinates. Without them we
    //    can't compute distance, so we go straight to the cluster fallback.
    if (subject && subject.latitude != null && subject.longitude != null) {
      const radius = await this.buildFromRadius(target, params, subject, now);
      if (radius) return radius;
    }

    // 3) Fallback: the legacy PropertyDetail cluster (supplemental source). Honest
    //    limit — this ignores radius, but it's better than no comps when the radius
    //    pool is empty. Never silently branded as "10 miles".
    return this.buildFromCluster(target, params);
  }

  /** The PRIMARY path: the real /v2/PropertySearch geo-radius sold-comp pool. */
  private async buildFromRadius(
    target: string,
    params: CompParams,
    subject: CompsSubject,
    now: Date
  ): Promise<CompsBuildResult | null> {
    const pool = await this.settings.poolParams();
    const raw = await this.realEstateDao.getCompCandidatesByRadius({
      latitude: subject.latitude!,
      longitude: subject.longitude!,
      propertyType: subject.propertyType,
      radiusMiles: pool.radiusMiles,
      soldSinceIso: isoDaysAgo(now, pool.maxDaysBack),
      maxCandidates: pool.maxCandidates,
    });
    if (!raw.length) return null;

    const opts: CompsSelectionOptions = {
      maxDistanceMiles: pool.radiusMiles,
      maxDaysBack: pool.maxDaysBack,
      maxComps: CompsSelectionEngine.TARGET_COMPS,
      now,
    };
    const candidates = raw.map((r) => mapCandidate(r, subject));
    const usable = filterUsable(candidates, subject, opts);
    if (!usable.length) return null; // nothing survives the hard rejects → try cluster

    const { picked, mode } = await this.select(usable, subject, opts);
    if (!picked.length) return null;

    const selected = picked.map(toSelectedComp);
    const data = this.toCompsData(target, params, subject, selected);
    return {
      data,
      record: { source: "radius", subject, selected, poolSize: raw.length, usableSize: usable.length },
      source: "radius",
      selectionMode: mode,
      poolSize: raw.length,
      usableSize: usable.length,
    };
  }

  /**
   * Select the strongest comps: try the admin-editable LLM prompt first (it only
   * ever CHOOSES ids from the pre-filtered usable set; the numbers are already
   * code-derived), and fall back to the deterministic rules on any failure/empty. The
   * deterministic path is also the floor when the LLM is unconfigured.
   */
  private async select(
    usable: CompCandidate[],
    subject: CompsSubject | null,
    opts: CompsSelectionOptions
  ): Promise<{ picked: CompCandidate[]; mode: "llm" | "deterministic" }> {
    const selection = await this.modelSettings.getEffectiveSelection("comps_selection");
    const llm = this.llmResolver.resolve(selection);
    if (llm.isAvailable) {
      try {
        const ids = await this.selectWithLlm(llm, usable, subject);
        const byId = new Map(usable.filter((c) => c.id != null).map((c) => [c.id!, c]));
        const picked: CompCandidate[] = [];
        for (const id of ids) {
          const c = byId.get(id);
          if (c && !picked.includes(c)) picked.push(c);
          if (picked.length >= CompsSelectionEngine.HARD_CAP) break;
        }
        if (picked.length) return { picked, mode: "llm" };
        console.warn("⚠️ CompsSelectionEngine: LLM selected no valid ids — using deterministic selection.");
      } catch (err) {
        console.error(
          "⚠️ CompsSelectionEngine: LLM selection failed — using deterministic selection:",
          err instanceof Error ? err.message : "unknown error"
        );
      }
    }
    return { picked: selectDeterministic(usable, subject, opts), mode: "deterministic" };
  }

  /** Run the structured LLM selection and return the ordered candidate ids it chose. */
  private async selectWithLlm(
    llm: LlmClient,
    usable: CompCandidate[],
    subject: CompsSubject | null
  ): Promise<string[]> {
    const style = await this.selectionPrompt.getEffectivePrompt();
    const system = [
      style.trim(),
      "",
      "HARD RULES — enforced by the system, they ALWAYS apply:",
      "- Return ONLY JSON matching the schema: an object with a `selected` array of candidate id strings, strongest comp first.",
      "- Every id MUST be one of the provided candidate ids. Never invent an id or return anything not in the list.",
      "- Return the best 3 when possible; return only 1 or 2 if only that many are strong; NEVER more than 5; never pad with weak comps.",
    ].join("\n");
    const user = JSON.stringify({ subject: subjectForLlm(subject), candidates: usable.map(candidateForLlm) });

    const rawJson = await llm.generateStructured({
      system,
      user,
      maxTokens: CompsSelectionEngine.SELECT_MAX_TOKENS,
      schema: CompsSelectionEngine.SELECT_SCHEMA,
      schemaName: "comp_selection",
    });
    const parsed = JSON.parse(rawJson) as { selected?: unknown };
    if (!parsed || !Array.isArray(parsed.selected)) return [];
    return parsed.selected.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
  }

  /** The legacy PropertyDetail(comps:true) cluster — the honest fallback source. */
  private async buildFromCluster(target: string, params: CompParams): Promise<CompsBuildResult> {
    const response = await this.realEstateDao.getCompsByAddress(target, {
      radiusMiles: params.radiusMiles,
      count: params.count,
      monthsBack: params.monthsBack,
    });
    const data = assembleCompsData(response, target, params);
    return {
      data,
      record: response,
      source: data.comps.length ? "cluster" : "none",
      selectionMode: "none",
      poolSize: 0,
      usableSize: 0,
    };
  }

  /** Map the selected comps into the formatter-ready {@link CompsData} (unchanged writer). */
  private toCompsData(
    target: string,
    params: CompParams,
    subject: CompsSubject | null,
    selected: SelectedComp[]
  ): CompsData {
    const comps: CompSaleData[] = selected.map((s) => {
      const out: CompSaleData = {};
      if (s.address != null) out.address = s.address;
      if (s.salePriceUsed != null) out.salePrice = s.salePriceUsed;
      if (s.bedrooms != null) out.beds = s.bedrooms;
      if (s.bathrooms != null) out.baths = s.bathrooms;
      if (s.squareFeet != null) out.squareFeet = s.squareFeet;
      if (s.distance != null) out.distanceMiles = s.distance;
      if (s.yearBuilt != null) out.yearBuilt = s.yearBuilt;
      if (s.daysOnMarket != null) out.daysOnMarket = s.daysOnMarket;
      if (s.saleDateUsed != null) out.saleDate = formatSaleDate(s.saleDateUsed);
      // JAK-164 addendum: the comp's OWN price per square foot — never the subject's.
      if (s.pricePerSquareFoot != null) out.pricePerSquareFoot = s.pricePerSquareFoot;
      return out;
    });

    const data: CompsData = {
      params,
      paramsSummary: formatCompParams(params),
      comps,
    };
    const subjectAddress = subject?.address ?? (target.trim() || undefined);
    if (subjectAddress) data.subjectAddress = subjectAddress;

    const prices = comps.map((c) => c.salePrice).filter((p): p is number => typeof p === "number");
    if (prices.length) {
      data.averageSalePrice = Math.round(prices.reduce((sum, p) => sum + p, 0) / prices.length);
    }
    if (subject?.estimatedValue != null) data.estimatedValue = subject.estimatedValue;
    return data;
  }
}

/** The subject slice handed to the LLM — only fields the selection heuristics use. */
function subjectForLlm(s: CompsSubject | null): Record<string, unknown> | null {
  if (!s) return null;
  return {
    propertyType: s.propertyType,
    landUse: s.landUse,
    zip: s.zip,
    county: s.county,
    fips: s.fips,
    bedrooms: s.bedrooms,
    bathrooms: s.bathrooms,
    livingSquareFeet: s.livingSquareFeet,
    lotSquareFeet: s.lotSquareFeet,
    yearBuilt: s.yearBuilt,
  };
}

/** The candidate slice handed to the LLM — id + the fields it ranks on (numbers code-derived). */
function candidateForLlm(c: CompCandidate): Record<string, unknown> {
  return {
    id: c.id,
    distanceMiles: c.distanceMiles,
    propertyType: c.propertyType,
    landUse: c.landUse,
    bedrooms: c.bedrooms,
    bathrooms: c.bathrooms,
    squareFeet: c.squareFeet,
    yearBuilt: c.yearBuilt,
    lotSquareFeet: c.lotSquareFeet,
    zip: c.zip,
    county: c.county,
    fips: c.fips,
    salePriceUsed: c.salePriceUsed,
    priceSourceUsed: c.priceSourceUsed,
    saleDateUsed: c.saleDateUsed,
    daysOnMarket: c.daysOnMarket,
    pricePerSquareFoot: c.pricePerSquareFoot,
    preForeclosure: c.preForeclosure,
    cashBuyer: c.cashBuyer,
    vacant: c.vacant,
  };
}

/** `YYYY-MM-DD` for `now` minus `days` days (UTC) — the PropertySearch sold filter. */
function isoDaysAgo(now: Date, days: number): string {
  const ms = now.getTime() - days * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

/** Normalize an ISO sale date to MM/DD/YYYY for the reply; pass others through. */
function formatSaleDate(raw: string): string {
  const m = raw.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[2]}/${m[3]}/${m[1]}` : raw.trim();
}
