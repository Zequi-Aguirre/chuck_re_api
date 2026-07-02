/**
 * "Jake Enrichment" summary note (JAK-107).
 *
 * Pure, side-effect-free rendering of an {@link EnrichmentResult} into the human
 * note body the worker drops on a contact after write-back
 * ({@link import("../api/GhlApiClient").GhlApiClient.createNote}). Kept separate
 * from the worker so the wording is exhaustively unit-testable and never touches
 * the network.
 *
 * It only ever reads enrichment output — never a credential — so the note can be
 * logged or stored safely.
 */
import { EnrichmentResult } from "../../types/LeadEnrichment";

/** Heading GHL shows on the note; also how a human recognizes Jake's note. */
export const ENRICHMENT_NOTE_HEADING = "🔎 Jake Enrichment";

/** Format a number as USD, no cents (GHL money fields are whole-dollar here). */
const usd = (value: number): string =>
  `$${Math.round(value).toLocaleString("en-US")}`;

/**
 * Render the summary note for an enrichment result. Only fields with a real
 * value appear — a missing owner or sale price is omitted rather than shown as
 * "unknown", so the note stays short and honest. Disqualification (with reasons)
 * is surfaced first when present, since it's the most actionable signal.
 */
export const buildEnrichmentNote = (result: EnrichmentResult): string => {
  const lines: string[] = [ENRICHMENT_NOTE_HEADING];

  if (result.disqualify) {
    const reasons = result.disqualifyReasons
      .map((r) => r.trim())
      .filter(Boolean)
      .join("; ");
    lines.push(`⚠️ Disqualified${reasons ? `: ${reasons}` : ""}`);
  }

  const owner = result.ownerName?.trim();
  if (owner) {
    lines.push(`Owner: ${owner}`);
  }

  lines.push(`Actively listed: ${result.isActiveListed ? "Yes" : "No"}`);

  if (typeof result.lastSalePrice === "number" && Number.isFinite(result.lastSalePrice)) {
    const soldOn = result.lastSoldDate?.trim();
    lines.push(
      `Last sale: ${usd(result.lastSalePrice)}${soldOn ? ` on ${soldOn}` : ""}`
    );
  } else if (result.lastSoldDate?.trim()) {
    lines.push(`Last sold: ${result.lastSoldDate.trim()}`);
  }

  if (typeof result.mortgageAmount === "number" && Number.isFinite(result.mortgageAmount)) {
    lines.push(`Open mortgage: ${usd(result.mortgageAmount)}`);
  }

  lines.push(`Foreclosure: ${result.foreclosureActive ? "Active" : "None"}`);

  return lines.join("\n");
};
