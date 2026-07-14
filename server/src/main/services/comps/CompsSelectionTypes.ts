// JAK-164 — the PURE core of the Comparable-Sales Selection Engine: the subject +
// candidate models, the numeric derivations (sale-price/date used, days on market,
// price-per-square-foot), the HARD-REJECT rules, the scoring/outlier logic, and the
// deterministic fallback selection. Everything here is pure + null-safe so it can be
// unit-tested without the network or an LLM, and so the numeric fields are correct
// REGARDLESS of what the LLM selects (the engine re-derives them from these).
//
// It reads ONLY fields the /v2/PropertySearch geo-radius pool actually ships (see
// RealEstateApiPropertySearchResult). Fields that endpoint does NOT return —
// `zoning`, `censusTract` — degrade to null and are simply never emitted, never
// fabricated.

import { RealEstateApiAddress, RealEstateApiPropertySearchResult } from "../../types/RealEstateApi";
import { haversineMiles } from "./haversine";

/** The subject property the candidates are compared against (from PropertySearch). */
export interface CompsSubject {
  id: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  county: string | null;
  fips: string | null;
  latitude: number | null;
  longitude: number | null;
  propertyType: string | null;
  propertyUse: string | null;
  landUse: string | null;
  bedrooms: number | null;
  bathrooms: number | null;
  livingSquareFeet: number | null;
  lotSquareFeet: number | null;
  yearBuilt: number | null;
  lastSaleDate: string | null;
  lastSalePrice: number | null;
  estimatedValue: number | null;
}

/** Where a comp's `salePriceUsed` came from — MLS sold price vs county deed. */
export type PriceSource = "mls" | "deed";

/**
 * One mapped candidate with the engine's DERIVED numeric fields attached. The
 * derived fields (`salePriceUsed`, `priceSourceUsed`, `saleDateUsed`,
 * `daysOnMarket`, `pricePerSquareFoot`, `distanceMiles`) are computed HERE from the
 * raw payload, so they are authoritative no matter which candidates the LLM picks.
 */
export interface CompCandidate {
  id: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  county: string | null;
  fips: string | null;
  distanceMiles: number | null;
  latitude: number | null;
  longitude: number | null;
  bedrooms: number | null;
  bathrooms: number | null;
  yearBuilt: number | null;
  squareFeet: number | null;
  lotSquareFeet: number | null;
  propertyType: string | null;
  landUse: string | null;
  zoning: string | null;
  censusTract: string | null;
  vacant: boolean | null;
  cashBuyer: boolean | null;
  preForeclosure: boolean | null;
  garageAvailable: boolean | null;
  airConditioningAvailable: boolean | null;
  lastSaleAmount: number | null;
  lastSaleDate: string | null;
  mlsSoldPrice: number | null;
  mlsListingDate: string | null;
  mlsLastStatusDate: string | null;
  mlsLastSaleDate: string | null;
  // Derived (authoritative, never from the LLM):
  salePriceUsed: number | null;
  priceSourceUsed: PriceSource | null;
  saleDateUsed: string | null;
  daysOnMarket: number | null;
  pricePerSquareFoot: number | null;
}

/**
 * The exact per-comp "Data to Return" shape the selection spec defines — the clean
 * record the report is built from. Only present values are set (missing stays
 * undefined, never null/blank), so the downstream formatter never renders a gap.
 */
export interface SelectedComp {
  id?: string;
  address?: string;
  city?: string;
  state?: string;
  zip?: string;
  county?: string;
  distance?: number;
  bedrooms?: number;
  bathrooms?: number;
  squareFeet?: number;
  yearBuilt?: number;
  lotSquareFeet?: number;
  salePriceUsed?: number;
  saleDateUsed?: string;
  priceSourceUsed?: PriceSource;
  mlsListingDate?: string;
  mlsLastSaleDate?: string;
  daysOnMarket?: number;
  pricePerSquareFoot?: number;
  propertyType?: string;
  landUse?: string;
  fips?: string;
  censusTract?: string;
  zoning?: string;
}

/** The tunable knobs the reject/selection rules read (from settings, with defaults). */
export interface CompsSelectionOptions {
  /** Hard distance ceiling in miles (spec: reject > 10 mi). */
  maxDistanceMiles: number;
  /** Sale-recency ceiling in days (spec: reject > 365 days). */
  maxDaysBack: number;
  /** Max comps to return (spec: best 3, up to 5). */
  maxComps: number;
  /** Evaluation "now" — the report date the recency window is measured from. */
  now: Date;
}

export const DEFAULT_SELECTION_OPTIONS: Omit<CompsSelectionOptions, "now"> = {
  maxDistanceMiles: 10,
  maxDaysBack: 365,
  maxComps: 3,
};

// ── small null-safe coercers ────────────────────────────────────────────────

const num = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const t = v.trim();
    if (t && Number.isFinite(Number(t))) return Number(t);
  }
  return null;
};

const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : null;

const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);

/** Parse an ISO-ish date to epoch ms, or null. Accepts "YYYY-MM-DD[...]". */
export function parseDateMs(raw: string | null | undefined): number | null {
  if (!raw || !raw.trim()) return null;
  const m = raw.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) {
    const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return Number.isFinite(ms) ? ms : null;
  }
  const ms = Date.parse(raw.trim());
  return Number.isFinite(ms) ? ms : null;
}

/** Whole calendar days between two ISO dates (b - a), or null if either is unparseable. */
export function daysBetween(a: string | null, b: string | null): number | null {
  const am = parseDateMs(a);
  const bm = parseDateMs(b);
  if (am == null || bm == null) return null;
  return Math.round((bm - am) / 86_400_000);
}

// ── address rendering ───────────────────────────────────────────────────────

const addressLine = (a: RealEstateApiAddress | string | null | undefined): string | null => {
  if (!a) return null;
  if (typeof a === "string") return str(a);
  const street = [a.house, a.street, a.streetType].filter(Boolean).join(" ").trim();
  const tail = [a.city, a.state, a.zip].map((x) => (x ?? "").toString().trim()).filter(Boolean).join(" ");
  const parts = [street, tail].filter(Boolean);
  return parts.length ? parts.join(", ") : str(a.label);
};

const addressField = (
  a: RealEstateApiAddress | string | null | undefined,
  key: "city" | "state" | "zip" | "county" | "fips"
): string | null => (a && typeof a === "object" ? str((a as Record<string, unknown>)[key]) : null);

// ── mapping ─────────────────────────────────────────────────────────────────

/** Map the subject PropertySearch record into the {@link CompsSubject}. */
export function mapSubject(raw: RealEstateApiPropertySearchResult | null | undefined): CompsSubject | null {
  if (!raw) return null;
  const a = raw.address;
  return {
    id: raw.id != null ? String(raw.id) : null,
    address: addressLine(a),
    city: raw.city ?? addressField(a, "city"),
    state: raw.state ?? addressField(a, "state"),
    zip: raw.zip ?? addressField(a, "zip"),
    county: raw.county ?? addressField(a, "county"),
    fips: addressField(a, "fips"),
    latitude: num(raw.latitude),
    longitude: num(raw.longitude),
    propertyType: str(raw.propertyType),
    propertyUse: str(raw.propertyUse),
    landUse: str(raw.landUse),
    bedrooms: num(raw.bedrooms),
    bathrooms: num(raw.bathrooms),
    livingSquareFeet: num(raw.squareFeet),
    lotSquareFeet: num(raw.lotSquareFeet),
    yearBuilt: num(raw.yearBuilt),
    lastSaleDate: str(raw.lastSaleDate),
    lastSalePrice: num(raw.lastSaleAmount),
    estimatedValue: num(raw.estimatedValue),
  };
}

/**
 * Map one raw PropertySearch candidate into a {@link CompCandidate}, computing the
 * haversine distance from the subject coords and the derived sale-price/date/DOM/PPSF
 * fields per the spec. Pure + null-safe; never fabricates a value.
 */
export function mapCandidate(
  raw: RealEstateApiPropertySearchResult,
  subject: CompsSubject | null
): CompCandidate {
  const a = raw.address;
  const latitude = num(raw.latitude);
  const longitude = num(raw.longitude);
  const distanceMiles =
    subject && subject.latitude != null && subject.longitude != null
      ? haversineMiles(subject.latitude, subject.longitude, latitude, longitude)
      : null;

  const squareFeet = num(raw.squareFeet);
  const lastSaleAmount = num(raw.lastSaleAmount);
  const lastSaleDate = str(raw.lastSaleDate);
  const mlsSoldPrice = num(raw.mlsSoldPrice);
  const mlsLastSaleDate = str(raw.mlsLastSaleDate);
  const mlsListingDate = str(raw.mlsListingDate);

  // Sale-price selection (spec): mlsSoldPrice when BOTH mlsSoldPrice AND
  // mlsLastSaleDate are present; else lastSaleAmount. Never estimatedValue/AVM.
  let salePriceUsed: number | null = null;
  let priceSourceUsed: PriceSource | null = null;
  let saleDateUsed: string | null = null;
  if (mlsSoldPrice != null && mlsSoldPrice > 0 && mlsLastSaleDate) {
    salePriceUsed = mlsSoldPrice;
    priceSourceUsed = "mls";
    saleDateUsed = mlsLastSaleDate;
  } else if (lastSaleAmount != null && lastSaleAmount > 0) {
    salePriceUsed = lastSaleAmount;
    priceSourceUsed = "deed";
    saleDateUsed = lastSaleDate;
  }

  // Days on market ONLY when both MLS dates exist (spec) — never estimated.
  const daysOnMarket =
    mlsListingDate && mlsLastSaleDate ? daysBetween(mlsListingDate, mlsLastSaleDate) : null;

  // PPSF = salePriceUsed / squareFeet, rounded; null when sqft missing/zero.
  const pricePerSquareFoot =
    salePriceUsed != null && squareFeet != null && squareFeet > 0
      ? Math.round(salePriceUsed / squareFeet)
      : null;

  return {
    id: raw.id != null ? String(raw.id) : null,
    address: addressLine(a),
    city: raw.city ?? addressField(a, "city"),
    state: raw.state ?? addressField(a, "state"),
    zip: raw.zip ?? addressField(a, "zip"),
    county: raw.county ?? addressField(a, "county"),
    fips: addressField(a, "fips"),
    distanceMiles: distanceMiles != null ? Math.round(distanceMiles * 100) / 100 : null,
    latitude,
    longitude,
    bedrooms: num(raw.bedrooms),
    bathrooms: num(raw.bathrooms),
    yearBuilt: num(raw.yearBuilt),
    squareFeet,
    lotSquareFeet: num(raw.lotSquareFeet),
    propertyType: str(raw.propertyType),
    landUse: str(raw.landUse),
    // Not shipped by /v2/PropertySearch — degrade to null, never fabricated.
    zoning: null,
    censusTract: null,
    vacant: bool(raw.vacant),
    cashBuyer: bool(raw.cashBuyer),
    preForeclosure: bool(raw.preForeclosure),
    garageAvailable: bool(raw.garage),
    airConditioningAvailable: bool(raw.airConditioningAvailable),
    lastSaleAmount,
    lastSaleDate,
    mlsSoldPrice,
    mlsListingDate,
    mlsLastStatusDate: str(raw.mlsLastStatusDate),
    mlsLastSaleDate,
    salePriceUsed,
    priceSourceUsed,
    saleDateUsed,
    daysOnMarket,
    pricePerSquareFoot,
  };
}

// ── hard-reject rules ───────────────────────────────────────────────────────

const isResidential = (landUse: string | null): boolean =>
  !!landUse && /resid/i.test(landUse);

/**
 * The ALWAYS-reject rules (spec "Hard Reject Rules", the non-contextual ones).
 * Returns a short reason string when the comp must be dropped, else null. The
 * CONTEXTUAL rejects (preForeclosure-when-enough-clean, PPSF outlier) are applied
 * over the surviving GROUP by {@link refineUsableGroup}, not here.
 */
export function hardRejectReason(
  c: CompCandidate,
  subject: CompsSubject | null,
  opts: CompsSelectionOptions
): string | null {
  // propertyType must match the subject's (when the subject has one).
  if (subject?.propertyType && c.propertyType) {
    if (c.propertyType.trim().toUpperCase() !== subject.propertyType.trim().toUpperCase()) {
      return "propertyType mismatch";
    }
  }
  // Non-residential landUse when the subject is residential.
  if (isResidential(subject?.landUse ?? null) && c.landUse && !isResidential(c.landUse)) {
    return "non-residential landUse";
  }
  if (c.salePriceUsed == null) return "no usable sale price";
  if (c.saleDateUsed == null) return "no usable sale date";
  if (c.squareFeet == null || c.squareFeet <= 0) return "squareFeet missing/zero";
  if (c.distanceMiles == null || c.distanceMiles > opts.maxDistanceMiles) {
    return "distance > max radius";
  }
  const ageDays = daysBetween(c.saleDateUsed, opts.now.toISOString());
  if (ageDays == null || ageDays > opts.maxDaysBack) return "sale older than window";
  // Living-area within 60% of the subject.
  if (subject?.livingSquareFeet != null && subject.livingSquareFeet > 0) {
    const pctDiff = Math.abs(c.squareFeet - subject.livingSquareFeet) / subject.livingSquareFeet;
    if (pctDiff > 0.6) return "squareFeet differs > 60%";
  }
  return null;
}

/** The usable candidates after the always-reject rules (order preserved). */
export function filterUsable(
  candidates: CompCandidate[],
  subject: CompsSubject | null,
  opts: CompsSelectionOptions
): CompCandidate[] {
  return candidates.filter((c) => hardRejectReason(c, subject, opts) == null);
}

/** Median of a numeric list (sorted copy), or null when empty. */
function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Apply the CONTEXTUAL rejects over the usable group (spec):
 *  - drop `preForeclosure` distressed comps WHEN >= 3 non-distressed remain;
 *  - drop PPSF OUTLIERS (> 35% from the group median PPSF) WHEN >= 3 in-band remain.
 * Never strips the group below what's needed to still return comps.
 */
export function refineUsableGroup(usable: CompCandidate[]): CompCandidate[] {
  // preForeclosure: only drop distressed when there are enough clean comps.
  const clean = usable.filter((c) => c.preForeclosure !== true);
  let group = clean.length >= 3 ? clean : usable;

  // PPSF outliers vs the group median.
  const ppsfs = group.map((c) => c.pricePerSquareFoot).filter((p): p is number => p != null);
  const med = median(ppsfs);
  if (med != null && med > 0) {
    const inBand = group.filter((c) => {
      if (c.pricePerSquareFoot == null) return true;
      return Math.abs(c.pricePerSquareFoot - med) / med <= 0.35;
    });
    if (inBand.length >= 3) group = inBand;
  }
  return group;
}

// ── deterministic scoring / selection ───────────────────────────────────────

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/** The spec's weighted 0-100 similarity score — used for the deterministic ordering. */
export function scoreCandidate(
  c: CompCandidate,
  subject: CompsSubject | null,
  opts: CompsSelectionOptions
): number {
  let score = 0;
  // Distance: 30 — closer is better.
  if (c.distanceMiles != null) score += 30 * clamp01(1 - c.distanceMiles / opts.maxDistanceMiles);
  // Sale recency: 20 — newer is better.
  const ageDays = daysBetween(c.saleDateUsed, opts.now.toISOString());
  if (ageDays != null) score += 20 * clamp01(1 - ageDays / opts.maxDaysBack);
  // Square footage similarity: 15.
  if (subject?.livingSquareFeet && c.squareFeet != null && subject.livingSquareFeet > 0) {
    const pctDiff = Math.abs(c.squareFeet - subject.livingSquareFeet) / subject.livingSquareFeet;
    score += 15 * clamp01(1 - pctDiff);
  }
  // Year-built similarity: 10 (within ~50 years).
  if (subject?.yearBuilt && c.yearBuilt != null) {
    score += 10 * clamp01(1 - Math.abs(c.yearBuilt - subject.yearBuilt) / 50);
  }
  // Bedroom / bathroom match: 7 each.
  if (subject?.bedrooms != null && c.bedrooms != null && subject.bedrooms === c.bedrooms) score += 7;
  if (subject?.bathrooms != null && c.bathrooms != null && subject.bathrooms === c.bathrooms) score += 7;
  // Lot size similarity: 4.
  if (subject?.lotSquareFeet && c.lotSquareFeet != null && subject.lotSquareFeet > 0) {
    const pctDiff = Math.abs(c.lotSquareFeet - subject.lotSquareFeet) / subject.lotSquareFeet;
    score += 4 * clamp01(1 - pctDiff);
  }
  // Location boundary bonuses.
  if (subject?.zip && c.zip && subject.zip === c.zip) score += 2;
  if (subject?.county && c.county && sameLoose(subject.county, c.county)) score += 2;
  if (subject?.fips && c.fips && subject.fips === c.fips) score += 1;
  return score;
}

const sameLoose = (a: string, b: string): boolean =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * DETERMINISTIC selection (the fallback when the LLM is unavailable/fails, and the
 * guaranteed floor). Filters by the hard-reject rules, refines the group for
 * distressed/outlier comps, then ranks by the weighted score (distance-then-recency
 * dominated) and returns the top {@link CompsSelectionOptions.maxComps} (capped 5).
 * Returns FEWER when fewer are usable — never pads with rejected comps.
 */
export function selectDeterministic(
  candidates: CompCandidate[],
  subject: CompsSubject | null,
  opts: CompsSelectionOptions
): CompCandidate[] {
  const usable = filterUsable(candidates, subject, opts);
  const group = refineUsableGroup(usable);
  const cap = Math.min(Math.max(opts.maxComps, 1), 5);
  return [...group]
    .sort((a, b) => {
      const s = scoreCandidate(b, subject, opts) - scoreCandidate(a, subject, opts);
      if (Math.abs(s) > 1e-9) return s;
      // Tie-break: closer first, then newer.
      const da = a.distanceMiles ?? Infinity;
      const db = b.distanceMiles ?? Infinity;
      if (da !== db) return da - db;
      return (parseDateMs(b.saleDateUsed) ?? 0) - (parseDateMs(a.saleDateUsed) ?? 0);
    })
    .slice(0, cap);
}

/** Project a chosen candidate into the clean "Data to Return" {@link SelectedComp}. */
export function toSelectedComp(c: CompCandidate): SelectedComp {
  const out: SelectedComp = {};
  const setStr = (k: keyof SelectedComp, v: string | null) => {
    if (v != null) (out[k] as unknown as string) = v;
  };
  const setNum = (k: keyof SelectedComp, v: number | null) => {
    if (v != null) (out[k] as unknown as number) = v;
  };
  setStr("id", c.id);
  setStr("address", c.address);
  setStr("city", c.city);
  setStr("state", c.state);
  setStr("zip", c.zip);
  setStr("county", c.county);
  setNum("distance", c.distanceMiles);
  setNum("bedrooms", c.bedrooms);
  setNum("bathrooms", c.bathrooms);
  setNum("squareFeet", c.squareFeet);
  setNum("yearBuilt", c.yearBuilt);
  setNum("lotSquareFeet", c.lotSquareFeet);
  setNum("salePriceUsed", c.salePriceUsed);
  setStr("saleDateUsed", c.saleDateUsed);
  if (c.priceSourceUsed) out.priceSourceUsed = c.priceSourceUsed;
  setStr("mlsListingDate", c.mlsListingDate);
  setStr("mlsLastSaleDate", c.mlsLastSaleDate);
  setNum("daysOnMarket", c.daysOnMarket);
  setNum("pricePerSquareFoot", c.pricePerSquareFoot);
  setStr("propertyType", c.propertyType);
  setStr("landUse", c.landUse);
  setStr("fips", c.fips);
  setStr("censusTract", c.censusTract);
  setStr("zoning", c.zoning);
  return out;
}
