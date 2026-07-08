/**
 * REAPI PropertyDetail → GHL auto-enrichment field formatter (JAK-184, epic JAK-180).
 *
 * A DETERMINISTIC, side-effect-free formatter — pure functions, NO LLM. Given a
 * REAPI PropertyDetail subject it returns the {@link AutoEnrichmentFields} logical
 * value object Eric's field spec describes. It calls nothing, reads no config, and
 * for the same input (and reference date) always returns the same output, so the
 * value-shaping rules are exhaustively unit-testable.
 *
 * It does NOT map to GHL field ids (JAK-185) and is NOT wired into any endpoint or
 * worker (JAK-183) — this ticket ships the formatter + its types + tests only,
 * exported for those later tickets to consume.
 *
 * Rules of thumb, applied uniformly:
 *   - MISSING/NULL is skipped — the key is omitted so a write never clobbers an
 *     existing GHL value with a blank. (`mlsStatus` is the sole always-present
 *     field; its spec default is "Off Market".)
 *   - Numbers tolerate the provider's `number | string` shaping and are coerced to
 *     a finite number (commas/`$` stripped); non-finite/blank → omitted.
 *   - Strings are trimmed; blank → omitted.
 */
import {
  AutoEnrichmentFields,
  MlsStatus,
  ReapiNumberLike,
  ReapiPropertyDetailEnvelope,
  ReapiPropertyDetailSubject,
} from "./AutoEnrichmentTypes";

/** Options for the formatter. */
export interface FormatEnrichmentOptions {
  /**
   * The "now" against which the Auction line's NEXT-UPCOMING date is chosen.
   * Injected so the formatter stays deterministic under test; defaults to the
   * current date. Only its UTC calendar day is used.
   */
  referenceDate?: Date;
}

/** A trimmed, non-empty string, or `undefined` to omit. */
const nonEmptyString = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

/**
 * Coerce a REAPI `number | string` to a finite number, or `undefined` to omit.
 * Accepts a bare number (0 is kept), or a numeric string with thousands commas /
 * a leading `$` (the provider occasionally ships those). NaN/Infinity/blank → omit.
 */
const finiteNumber = (value: ReapiNumberLike | unknown): number | undefined => {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") {
    const cleaned = value.trim().replace(/[$,]/g, "");
    if (cleaned.length === 0) return undefined;
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
};

/** First value from the ordered fallbacks that resolves via `pick`, else undefined. */
const firstOf = <T>(
  pick: (raw: unknown) => T | undefined,
  ...raws: unknown[]
): T | undefined => {
  for (const raw of raws) {
    const value = pick(raw);
    if (value !== undefined) return value;
  }
  return undefined;
};

// ── Deal signals ──────────────────────────────────────────────────────────────

/**
 * A boolean deal-signal flag on the subject. Listed explicitly (rather than
 * derived) because the subject's forward-compat index signature would otherwise
 * collapse a mapped-type derivation to `never`. `auction` is intentionally absent
 * — it's rendered by {@link auctionLine}, not as a plain label.
 */
type BooleanSignalKey =
  | "preForeclosure"
  | "taxLien"
  | "lien"
  | "bankOwned"
  | "vacant"
  | "inherited"
  | "death"
  | "deathTransfer"
  | "highEquity"
  | "freeClear"
  | "outOfStateAbsenteeOwner"
  | "inStateAbsenteeOwner"
  | "absenteeOwner"
  | "corporateOwned"
  | "investorBuyer"
  | "cashBuyer"
  | "mobileHome"
  | "MFH2to4"
  | "MFH5plus";

/** One entry in the priority-ordered signal list. Auction is special-cased. */
type SignalDef =
  | { kind: "flag"; label: string; key: BooleanSignalKey }
  | { kind: "auction" };

/**
 * The deal signals in Eric's PRIORITY order (NOT the API's field order). Only
 * signals that are literally `true` are emitted, each on its own line, in this
 * order. Auction is positioned at #2 but renders with its date (see below).
 */
const SIGNAL_ORDER: readonly SignalDef[] = [
  { kind: "flag", label: "Pre-Foreclosure", key: "preForeclosure" },
  { kind: "auction" },
  { kind: "flag", label: "Tax Lien", key: "taxLien" },
  { kind: "flag", label: "Lien", key: "lien" },
  { kind: "flag", label: "Bank Owned", key: "bankOwned" },
  { kind: "flag", label: "Vacant", key: "vacant" },
  { kind: "flag", label: "Inherited", key: "inherited" },
  { kind: "flag", label: "Death", key: "death" },
  { kind: "flag", label: "Death Transfer", key: "deathTransfer" },
  { kind: "flag", label: "High Equity", key: "highEquity" },
  { kind: "flag", label: "Free & Clear", key: "freeClear" },
  { kind: "flag", label: "Out-of-State Absentee", key: "outOfStateAbsenteeOwner" },
  { kind: "flag", label: "In-State Absentee", key: "inStateAbsenteeOwner" },
  { kind: "flag", label: "Absentee Owner", key: "absenteeOwner" },
  { kind: "flag", label: "Corporate Owned", key: "corporateOwned" },
  { kind: "flag", label: "Investor Buyer", key: "investorBuyer" },
  { kind: "flag", label: "Cash Buyer", key: "cashBuyer" },
  { kind: "flag", label: "Mobile Home", key: "mobileHome" },
  { kind: "flag", label: "MFH 2-4", key: "MFH2to4" },
  { kind: "flag", label: "MFH 5+", key: "MFH5plus" },
];

/** A signal is on only when the provider ships literal boolean `true`. */
const isSignalTrue = (value: unknown): boolean => value === true;

/**
 * Parse a REAPI date string to a `YYYYMMDD` numeric key for comparison, or
 * `undefined`. Accepts an ISO-ish `YYYY-MM-DD...` (with any time suffix) or a US
 * `MM/DD/YYYY`. Purely lexical — no `Date` parsing — so it never shifts a day
 * across a timezone.
 */
const dateSortKey = (raw: string): number | undefined => {
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw.trim());
  if (iso) return Number(`${iso[1]}${iso[2]}${iso[3]}`);
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(raw.trim());
  if (us) {
    const mm = us[1].padStart(2, "0");
    const dd = us[2].padStart(2, "0");
    return Number(`${us[3]}${mm}${dd}`);
  }
  return undefined;
};

/** Format a REAPI date string as MM/DD/YYYY, or `undefined` if unparseable. */
const toMmDdYyyy = (raw: string): string | undefined => {
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw.trim());
  if (iso) return `${iso[2]}/${iso[3]}/${iso[1]}`;
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(raw.trim());
  if (us) return `${us[1].padStart(2, "0")}/${us[2].padStart(2, "0")}/${us[3]}`;
  return undefined;
};

/** The reference date as a `YYYYMMDD` key, using its UTC calendar day. */
const referenceSortKey = (referenceDate: Date): number => {
  const y = referenceDate.getUTCFullYear();
  const m = String(referenceDate.getUTCMonth() + 1).padStart(2, "0");
  const d = String(referenceDate.getUTCDate()).padStart(2, "0");
  return Number(`${y}${m}${d}`);
};

/**
 * The Auction deal-signal line for a subject whose `auction` flag is true.
 *   - a foreclosure record carries an auction date → "Auction: MM/DD/YYYY"
 *   - multiple auction records → the NEXT UPCOMING date (earliest on/after the
 *     reference day); if every auction date is in the past, the most recent one
 *     (so a known date is still shown rather than dropped)
 *   - the flag is true but no parseable date exists → "Auction"
 */
const auctionLine = (
  subject: ReapiPropertyDetailSubject,
  referenceDate: Date
): string => {
  const dated = (subject.foreclosureInfo ?? [])
    .map((item) => {
      const raw = nonEmptyString(item?.auctionDate);
      const key = raw !== undefined ? dateSortKey(raw) : undefined;
      return raw !== undefined && key !== undefined ? { raw, key } : undefined;
    })
    .filter((d): d is { raw: string; key: number } => d !== undefined);

  if (dated.length === 0) return "Auction";

  const refKey = referenceSortKey(referenceDate);
  const upcoming = dated
    .filter((d) => d.key >= refKey)
    .sort((a, b) => a.key - b.key);
  const chosen =
    upcoming.length > 0
      ? upcoming[0]
      : [...dated].sort((a, b) => b.key - a.key)[0];

  const formatted = toMmDdYyyy(chosen.raw);
  return formatted !== undefined ? `Auction: ${formatted}` : "Auction";
};

/**
 * Build the multi-line deal-signals string in priority order, including only the
 * signals that are true. Returns `undefined` when none are (→ the field is omitted).
 */
const formatDealSignals = (
  subject: ReapiPropertyDetailSubject,
  referenceDate: Date
): string | undefined => {
  const lines: string[] = [];
  for (const def of SIGNAL_ORDER) {
    if (def.kind === "auction") {
      if (isSignalTrue(subject.auction)) lines.push(auctionLine(subject, referenceDate));
      continue;
    }
    if (isSignalTrue(subject[def.key])) lines.push(def.label);
  }
  return lines.length > 0 ? lines.join("\n") : undefined;
};

// ── MLS status ────────────────────────────────────────────────────────────────

/** Status tokens that mean the property is CURRENTLY listed on the MLS. */
const LISTED_STATUS_TOKENS: readonly string[] = [
  "active",
  "pending",
  "coming soon",
  "coming-soon",
  "contingent",
  "under contract",
  "active under contract",
  "back on market",
  "new",
  "reactivated",
];

/**
 * "Listed" for any currently-listed MLS status, else "Off Market". A truthy
 * `mlsActive` flag, or an `mlsStatus` string containing a currently-listed token,
 * counts as listed; everything else (sold/closed/expired/withdrawn/absent) is
 * "Off Market" — the explicit spec default.
 */
const formatMlsStatus = (subject: ReapiPropertyDetailSubject): MlsStatus => {
  if (subject.mlsActive === true) return "Listed";
  const status = nonEmptyString(subject.mlsStatus)?.toLowerCase();
  if (status && LISTED_STATUS_TOKENS.some((token) => status.includes(token))) {
    return "Listed";
  }
  return "Off Market";
};

// ── Years owned ───────────────────────────────────────────────────────────────

/**
 * Ownership length (in MONTHS) → "N.N Years" (1 decimal). e.g. 182 → "15.2 Years",
 * 120 → "10.0 Years", 18 → "1.5 Years", 6 → "0.5 Years". Missing/non-finite → omit.
 */
const formatYearsOwned = (months: ReapiNumberLike): string | undefined => {
  const value = finiteNumber(months);
  if (value === undefined) return undefined;
  return `${(value / 12).toFixed(1)} Years`;
};

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Unwrap a PropertyDetail response envelope to its subject. Tolerates the
 * provider's `{ data }`, a `{ subject }` alias, or a bare subject object; returns
 * `undefined` for a null/undefined/non-object input.
 */
export const extractEnrichmentSubject = (
  input: ReapiPropertyDetailEnvelope | ReapiPropertyDetailSubject | null | undefined
): ReapiPropertyDetailSubject | undefined => {
  if (input === null || typeof input !== "object") return undefined;
  const envelope = input as ReapiPropertyDetailEnvelope;
  if (envelope.data && typeof envelope.data === "object") return envelope.data;
  if (envelope.subject && typeof envelope.subject === "object") return envelope.subject;
  return input as ReapiPropertyDetailSubject;
};

/**
 * Format a REAPI PropertyDetail subject into the logical auto-enrichment field
 * values. Pure: same subject (and `referenceDate`) always yields the same object.
 * Omits every field the subject has no usable value for; `mlsStatus` is always set.
 */
export const formatPropertyDetailEnrichment = (
  subject: ReapiPropertyDetailSubject,
  options: FormatEnrichmentOptions = {}
): AutoEnrichmentFields => {
  const referenceDate = options.referenceDate ?? new Date();
  const propertyInfo = subject.propertyInfo ?? undefined;
  const ownerInfo = subject.ownerInfo ?? undefined;
  const lastSale = subject.lastSale ?? undefined;

  const fields: AutoEnrichmentFields = {
    mlsStatus: formatMlsStatus(subject),
  };

  const assign = <K extends keyof AutoEnrichmentFields>(
    key: K,
    value: AutoEnrichmentFields[K] | undefined
  ): void => {
    if (value !== undefined) fields[key] = value;
  };

  assign("dealSignals", formatDealSignals(subject, referenceDate));
  assign("propertyType", nonEmptyString(subject.propertyType));
  assign("estimatedEquity", finiteNumber(subject.estimatedEquity));
  assign("equityPercent", finiteNumber(subject.equityPercent));
  assign("estimatedValue", finiteNumber(subject.estimatedValue));
  assign(
    "mortgageBalance",
    firstOf(finiteNumber, subject.openMortgageBalance, subject.estimatedMortgageBalance)
  );
  assign("monthlyMortgage", finiteNumber(subject.estimatedMortgagePayment));
  assign(
    "ownerOfRecord",
    firstOf(
      nonEmptyString,
      ownerInfo?.owner1FullName,
      ownerInfo?.companyName,
      ownerInfo?.ownerNames?.[0]
    )
  );
  assign("yearsOwned", formatYearsOwned(ownerInfo?.ownershipLength));
  assign("beds", finiteNumber(propertyInfo?.bedrooms));
  assign("baths", finiteNumber(propertyInfo?.bathrooms));
  assign(
    "sqFt",
    firstOf(finiteNumber, propertyInfo?.livingSquareFeet, propertyInfo?.buildingSquareFeet)
  );
  assign(
    "lotSize",
    firstOf(finiteNumber, subject.lotInfo?.lotSquareFeet, propertyInfo?.lotSquareFeet)
  );
  assign("yearBuilt", finiteNumber(propertyInfo?.yearBuilt));
  assign("lastSaleDate", firstOf(nonEmptyString, subject.lastSaleDate, lastSale?.saleDate));
  assign("lastSalePrice", firstOf(finiteNumber, subject.lastSalePrice, lastSale?.saleAmount));
  assign("propertyAddress", nonEmptyString(propertyInfo?.address?.label));

  return fields;
};
