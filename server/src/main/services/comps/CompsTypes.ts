// JAK-137 / JAK-144 — Comps specialist types: the comp PARAMETERS model (defaults,
// texter overrides, clamping), the clean verified shape the writer consumes, the
// pure assembler that turns the (normalized) comps response into it, and the
// cache/pending persistence rows. (JAK-144: comps are pulled via PropertyDetail
// with comps:true and normalized by the DAO — the standalone PropertyComps
// endpoints are not authorized for this key.)

import {
  RealEstateApiAddress,
  RealEstateApiCompRecord,
  RealEstateApiCompsSubject,
  RealEstateApiPropertyCompsResponse,
} from "../../types/RealEstateApi";
import { haversineMiles } from "./haversine";

/**
 * The comp PARAMETERS that shape a comps pull (JAK-137). Zequi wants these
 * first-class: search radius, number of comps, timeframe (recent months), and
 * bed/bath/sqft tolerance. The admin sets the DEFAULTS (CompsSettingsService), a
 * texter can OVERRIDE any of them in the message ("comps within 1 mile, last 6
 * months, 3 similar homes"), and every value is clamped to sane bounds in code.
 * radius/count/timeframe go to the API; the tolerances are applied against the
 * returned subject when assembling the reply.
 */
export interface CompParams {
  /** Search radius in miles. */
  radiusMiles: number;
  /** How many comparable sales to return. */
  count: number;
  /** Recency window — only sales within the last N months. */
  monthsBack: number;
  /** Keep comps whose bed count is within ±this of the subject. */
  bedsTolerance: number;
  /** Keep comps whose bath count is within ±this of the subject. */
  bathsTolerance: number;
  /** Keep comps whose living sqft is within ±this percent of the subject. */
  sqftTolerancePct: number;
}

/** A texter-supplied partial override of the default comp parameters. */
export type CompParamOverrides = Partial<CompParams>;

/** Inclusive clamp bounds for each comp parameter — the sane-bounds guardrail. */
export const COMP_PARAM_BOUNDS: Record<keyof CompParams, { min: number; max: number }> = {
  radiusMiles: { min: 0.1, max: 10 },
  count: { min: 1, max: 10 },
  monthsBack: { min: 1, max: 24 },
  bedsTolerance: { min: 0, max: 3 },
  bathsTolerance: { min: 0, max: 3 },
  sqftTolerancePct: { min: 0, max: 100 },
};

/**
 * The code DEFAULT comp parameters. Single source of truth for the fallback used
 * when nothing is stored; it MIRRORS the seed in the seed_comps_settings
 * migration.
 */
export const DEFAULT_COMP_PARAMS: CompParams = {
  radiusMiles: 1,
  count: 5,
  monthsBack: 12,
  bedsTolerance: 1,
  bathsTolerance: 1,
  sqftTolerancePct: 25,
};

const clampNumber = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

/** Round to one decimal (radius is the only fractional parameter). */
const round1 = (value: number): number => Math.round(value * 10) / 10;

/**
 * Clamp every parameter to its sane bounds. radius keeps one decimal; the rest are
 * whole numbers. A bad stored/override value can never push a parameter out of
 * range (e.g. a 500-mile radius or 0 comps).
 */
export function clampCompParams(params: CompParams): CompParams {
  return {
    radiusMiles: round1(clampNumber(params.radiusMiles, COMP_PARAM_BOUNDS.radiusMiles.min, COMP_PARAM_BOUNDS.radiusMiles.max)),
    count: Math.round(clampNumber(params.count, COMP_PARAM_BOUNDS.count.min, COMP_PARAM_BOUNDS.count.max)),
    monthsBack: Math.round(clampNumber(params.monthsBack, COMP_PARAM_BOUNDS.monthsBack.min, COMP_PARAM_BOUNDS.monthsBack.max)),
    bedsTolerance: Math.round(clampNumber(params.bedsTolerance, COMP_PARAM_BOUNDS.bedsTolerance.min, COMP_PARAM_BOUNDS.bedsTolerance.max)),
    bathsTolerance: Math.round(clampNumber(params.bathsTolerance, COMP_PARAM_BOUNDS.bathsTolerance.min, COMP_PARAM_BOUNDS.bathsTolerance.max)),
    sqftTolerancePct: Math.round(clampNumber(params.sqftTolerancePct, COMP_PARAM_BOUNDS.sqftTolerancePct.min, COMP_PARAM_BOUNDS.sqftTolerancePct.max)),
  };
}

/**
 * Resolve the effective parameters for one request: start from the admin defaults,
 * apply only the texter's explicitly-supplied (finite-number) overrides, then
 * clamp. A missing or non-numeric override leaves the default in place.
 */
export function resolveCompParams(
  defaults: CompParams,
  overrides?: CompParamOverrides | null
): CompParams {
  const merged: CompParams = { ...defaults };
  if (overrides) {
    for (const key of Object.keys(defaults) as (keyof CompParams)[]) {
      const value = overrides[key];
      if (typeof value === "number" && Number.isFinite(value)) merged[key] = value;
    }
  }
  return clampCompParams(merged);
}

/**
 * Parse a stored `comps_params` JSON value into a full, clamped parameter-set,
 * filling any missing/invalid field from {@link DEFAULT_COMP_PARAMS}. Returns null
 * only when the value isn't usable JSON at all, so the settings service can fall
 * back to the code default.
 */
export function parseStoredCompParams(raw: string | null | undefined): CompParams | null {
  if (!raw || !raw.trim()) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  return resolveCompParams(DEFAULT_COMP_PARAMS, obj as CompParamOverrides);
}

/**
 * A plain-English, emoji-free summary of the parameters a reply used — Zequi wants
 * the reply to STATE the parameters. e.g. "radius 1 mi, up to 5 comps, sold in the
 * last 12 months, beds ±1, baths ±1, sqft ±25%".
 */
export function formatCompParams(p: CompParams): string {
  const comps = `up to ${p.count} comp${p.count === 1 ? "" : "s"}`;
  const months = `sold in the last ${p.monthsBack} month${p.monthsBack === 1 ? "" : "s"}`;
  return [
    `radius ${p.radiusMiles} mi`,
    comps,
    months,
    `beds ±${p.bedsTolerance}`,
    `baths ±${p.bathsTolerance}`,
    `sqft ±${p.sqftTolerancePct}%`,
  ].join(", ");
}

/** One comparable sale, reduced to the VERIFIED values worth texting. */
export interface CompSaleData {
  address?: string;
  salePrice?: number;
  beds?: number;
  baths?: number;
  squareFeet?: number;
  /** JAK-160: real great-circle miles from the subject; unset if either lacks coords. */
  distanceMiles?: number;
  /** JAK-160: the comp's year built, when the provider returned one. */
  yearBuilt?: number;
  /** JAK-160: MLS days on market — present only on MLS-tracked comps (~20-30%). */
  daysOnMarket?: number;
  saleDate?: string;
  /**
   * JAK-164: the comp's OWN price per square foot (salePriceUsed / squareFeet),
   * computed by the selection engine. Set only when the comp had a usable own price
   * AND square footage — never borrowed from the subject or another comp.
   */
  pricePerSquareFoot?: number;
}

/**
 * The VERIFIED, SMS-ready shape the comps specialist writes from (JAK-137). Only
 * present values are set on each comp (missing stays undefined, never null/blank),
 * so the writer and its deterministic fallback both work off ground truth and
 * never invent a comp or a price. `params`/`paramsSummary` let the reply state
 * exactly what was searched. Mirrors how SkipTraceData fronts the skip-trace writer.
 */
export interface CompsData {
  /** The subject property address the comps are for (reply header). */
  subjectAddress?: string;
  /** The resolved (clamped) parameters this pull used. */
  params: CompParams;
  /** Human-readable one-liner of {@link params} for the reply. */
  paramsSummary: string;
  /** The comparable sales, tolerance-filtered + capped at `params.count`. */
  comps: CompSaleData[];
  /** Subject AVM point estimate, when the provider returned one. */
  estimatedValue?: number;
  /** Subject AVM low bound, when present. */
  estimatedValueLow?: number;
  /** Subject AVM high bound, when present. */
  estimatedValueHigh?: number;
  /** Mean sale price of the included comps, when at least one has a price. */
  averageSalePrice?: number;
}

/** True when a comps pull produced at least one comparable sale worth billing for. */
export function hasComps(data: CompsData): boolean {
  return data.comps.length > 0;
}

const text = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : null;

// JAK-144: the provider ships comp numerics inconsistently — some as numbers
// (bathrooms), many as strings ("250000", "4", "2083"). Coerce a finite numeric
// string too, so prices/beds/baths/sqft aren't silently dropped from the reply and
// the tolerance filters actually compare. Non-numeric / blank stays null (never
// fabricated).
const num = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const t = v.trim();
    if (t && Number.isFinite(Number(t))) return Number(t);
  }
  return null;
};

/** Normalize an ISO (YYYY-MM-DD…) sale date to MM/DD/YYYY; pass others through. */
function formatSaleDate(raw: string): string {
  const s = raw.trim();
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return iso ? `${iso[2]}/${iso[3]}/${iso[1]}` : s;
}

/** Render a comp/subject address (string or structured) into a display line. */
function addressDisplay(address: RealEstateApiAddress | string | null | undefined): string | null {
  if (!address) return null;
  if (typeof address === "string") return text(address);
  const street = [address.house, address.street, address.streetType].filter(Boolean).join(" ").trim();
  const tail = [address.city, address.state, address.zip].map((x) => (x ?? "").toString().trim()).filter(Boolean).join(" ");
  const parts = [street, tail].filter(Boolean);
  return parts.length ? parts.join(", ") : text(address.label);
}

const subjectBeds = (s: RealEstateApiCompsSubject | null): number | null => (s ? num(s.bedrooms) : null);
const subjectBaths = (s: RealEstateApiCompsSubject | null): number | null => (s ? num(s.bathrooms) : null);
const subjectSqft = (s: RealEstateApiCompsSubject | null): number | null =>
  s ? num(s.squareFeet) ?? num(s.livingSquareFeet) : null;

/** Keep a comp only if every dimension we CAN compare is within tolerance. */
function withinTolerance(
  comp: RealEstateApiCompRecord,
  subject: RealEstateApiCompsSubject | null,
  params: CompParams
): boolean {
  const sBeds = subjectBeds(subject);
  const cBeds = num(comp.bedrooms);
  if (sBeds != null && cBeds != null && Math.abs(cBeds - sBeds) > params.bedsTolerance) return false;

  const sBaths = subjectBaths(subject);
  const cBaths = num(comp.bathrooms);
  if (sBaths != null && cBaths != null && Math.abs(cBaths - sBaths) > params.bathsTolerance) return false;

  const sSqft = subjectSqft(subject);
  const cSqft = num(comp.squareFeet);
  if (sSqft != null && sSqft > 0 && cSqft != null) {
    const pctDiff = (Math.abs(cSqft - sSqft) / sSqft) * 100;
    if (pctDiff > params.sqftTolerancePct) return false;
  }
  return true;
}

/** The subject's geo-coordinates, when both are present — the haversine origin. */
interface SubjectCoords {
  lat: number;
  lon: number;
}

/**
 * Map one raw comp record into the verified SMS shape (only present values).
 * JAK-160: when the subject AND this comp both carry coordinates, the real
 * great-circle distance (miles) is computed here — the provider ships no distance
 * field on this endpoint, so the old `comp.distance` mapping was always empty.
 */
function toCompSale(comp: RealEstateApiCompRecord, subjectCoords: SubjectCoords | null): CompSaleData {
  const out: CompSaleData = {};
  const address = addressDisplay(comp.address);
  if (address) out.address = address;
  // JAK-144: the provider ships lastSaleAmount as "0" for some records (no usable
  // sale price). Prefer the first POSITIVE of lastSaleAmount / mlsSoldPrice so the
  // reply never renders a "$0" comp; omit the price when neither is positive.
  const price = [num(comp.lastSaleAmount), num(comp.mlsSoldPrice)].find(
    (p): p is number => p != null && p > 0
  );
  if (price != null) out.salePrice = price;
  const beds = num(comp.bedrooms);
  if (beds != null) out.beds = beds;
  const baths = num(comp.bathrooms);
  if (baths != null) out.baths = baths;
  const sqft = num(comp.squareFeet);
  if (sqft != null) out.squareFeet = sqft;
  // JAK-160: real haversine distance from the subject. Requires coords on BOTH
  // sides; a comp missing coords simply carries no distance (never fabricated).
  if (subjectCoords) {
    const compLat = num(comp.latitude);
    const compLon = num(comp.longitude);
    const miles = haversineMiles(subjectCoords.lat, subjectCoords.lon, compLat, compLon);
    if (miles != null) out.distanceMiles = Math.round(miles * 100) / 100;
  }
  // JAK-160: year built (provider ships it as a string) and MLS days on market
  // (present only on MLS-tracked comps). Set ONLY when present — never invented.
  const yearBuilt = num(comp.yearBuilt);
  if (yearBuilt != null) out.yearBuilt = yearBuilt;
  const daysOnMarket = num(comp.mlsDaysOnMarket);
  if (daysOnMarket != null) out.daysOnMarket = daysOnMarket;
  const saleDate = text(comp.lastSaleDate) ?? text(comp.mlsLastStatusDate);
  if (saleDate) out.saleDate = formatSaleDate(saleDate);
  return out;
}

/**
 * Assemble the clean, verified {@link CompsData} from the normalized comps
 * response (JAK-137 / JAK-144). Pure + null-safe: it reads comps from `comps` or `data`,
 * filters them to the bed/bath/sqft tolerance against the returned subject (skipping
 * any dimension either side is missing), computes each comp's real great-circle
 * distance from the subject (JAK-160: haversine, no maps API), SORTS by that
 * distance nearest-first (comps with no distance sort last), takes the closest
 * `params.count`, and derives the average sale price + AVM range ONLY from values
 * the provider returned. Never fabricates a comp, price, or range. Mirrors
 * assembleSkipTraceData.
 */
export function assembleCompsData(
  response: RealEstateApiPropertyCompsResponse | null,
  target: string,
  params: CompParams
): CompsData {
  const data: CompsData = {
    params,
    paramsSummary: formatCompParams(params),
    comps: [],
  };
  if (target.trim()) data.subjectAddress = target.trim();
  if (!response) return data;

  const subject = response.subject ?? null;
  const rawComps: RealEstateApiCompRecord[] = response.comps ?? response.data ?? [];

  // JAK-160: the subject's coordinates are the origin for every comp's distance.
  const subjLat = subject ? num(subject.latitude) : null;
  const subjLon = subject ? num(subject.longitude) : null;
  const subjectCoords: SubjectCoords | null =
    subjLat != null && subjLon != null ? { lat: subjLat, lon: subjLon } : null;

  // Tolerance-filter, compute distances, then order NEAREST-FIRST and take the
  // closest `count`. Comps with no computed distance sort last (stable order),
  // so a missing-coords comp is kept but never jumps ahead of a real neighbor.
  const filtered = rawComps
    .filter((c) => withinTolerance(c, subject, params))
    .map((c) => toCompSale(c, subjectCoords))
    .sort((a, b) => {
      if (a.distanceMiles == null && b.distanceMiles == null) return 0;
      if (a.distanceMiles == null) return 1;
      if (b.distanceMiles == null) return -1;
      return a.distanceMiles - b.distanceMiles;
    })
    .slice(0, params.count);
  data.comps = filtered;

  const prices = filtered.map((c) => c.salePrice).filter((p): p is number => typeof p === "number");
  if (prices.length) {
    data.averageSalePrice = Math.round(prices.reduce((sum, p) => sum + p, 0) / prices.length);
  }

  const avm = num(response.reapiAvm);
  if (avm != null) data.estimatedValue = avm;
  const low = num(response.reapiAvmLow);
  if (low != null) data.estimatedValueLow = low;
  const high = num(response.reapiAvmHigh);
  if (high != null) data.estimatedValueHigh = high;

  return data;
}

/**
 * Canonical cache key for a comps request: the whitespace-collapsed, lower-cased
 * target address folded together with a stable signature of the resolved
 * parameters, so a repeat of the SAME address AND the SAME parameter-set hits the
 * same cache row — but a different parameter-set is a NEW request, not a hit.
 */
export function compsTargetKey(target: string): string {
  return String(target).trim().toLowerCase().replace(/\s+/g, " ");
}

/** A stable, order-fixed signature of a parameter-set for the cache key. */
export function compsParamsKey(p: CompParams): string {
  return `r${p.radiusMiles}|c${p.count}|m${p.monthsBack}|bd${p.bedsTolerance}|ba${p.bathsTolerance}|sf${p.sqftTolerancePct}`;
}

/** The full per-(phone, target, param-set) cache key stored in `target_key`. */
export function compsCacheKey(target: string, params: CompParams): string {
  return `${compsTargetKey(target)}#${compsParamsKey(params)}`;
}

/**
 * Raw persistence row for `text_jake_comps` (JAK-137) — a snapshot of one PAID
 * comps pull, the backing store for the free re-serve rule (a repeat of the same
 * target AND parameter-set within the free window is served free from here). The
 * SAME shape as the JAK-136 skip-trace cache, keyed per (phone, target, params).
 */
export interface CompsRow {
  id: string;
  customer_id: string;
  phone: string;
  message_id: string | null;
  normalized_target: string;
  /** Canonical cache key (address + params signature). */
  target_key: string;
  /** The resolved parameter-set that produced this snapshot. */
  params: unknown;
  /** The FULL verified /v3/PropertyComps response. */
  comps_record: unknown;
  /** The exact SMS we sent, so a free re-serve returns the identical reply. */
  report_text: string;
  fetched_at: Date;
  created_at: Date;
}

/**
 * Raw persistence row for `text_jake_comps_pending` (JAK-137) — the ONE outstanding
 * "reply OK to run it" comps offer per phone (upserted). Because comps cost more
 * than a report, we NEVER spend on the first ask: we quote the price + parameters,
 * store this row, and consume it when the texter confirms with OK/YES. `params`
 * captures the resolved parameter-set so it can't drift before confirmation.
 */
export interface CompsPendingRow {
  phone: string;
  customer_id: string;
  /** The address the pending comps pull will run on. */
  target: string;
  /** The resolved parameters it will use (captured at offer time). */
  params: CompParams;
  /** The credits it will cost (captured at offer time so the price can't drift). */
  credits: number;
  created_at: Date;
}
