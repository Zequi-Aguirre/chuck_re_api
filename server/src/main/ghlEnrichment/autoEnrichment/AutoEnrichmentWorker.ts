/**
 * Auto-enrichment worker / processor (JAK-183, epic JAK-180).
 *
 * The integration piece that ties the merged parts together. For ONE dequeued job
 * it runs the full pipeline:
 *
 *   job → resolve+normalize the property address → REAPI PropertyDetail lookup
 *       → PropertyDetailEnrichmentFormatter (JAK-184) → writeEnrichmentFields (JAK-185)
 *
 * It is a pure processor: the JAK-197 {@link InProcessEnrichmentRunner} owns the
 * concurrency + retry/backoff lifecycle and calls {@link process} per job. Keeping
 * the pipeline here — free of any queue — makes it unit-testable with the DAO +
 * write-back mocked (no real REAPI/GHL).
 *
 * Reuse, not reinvention:
 *   - address: {@link partsFromFields} builds CLEAN structured parts (JAK-193 — bare
 *     zip, state normalized/zip-derived) passed straight to REAPI (no lossy reparse).
 *   - REAPI: the EXISTING {@link RealEstateApiDao} (same paidPost chokepoint + the
 *     JAK-110 dev-no-spend gate) — no new REAPI client.
 *   - format: the merged JAK-184 {@link formatPropertyDetailEnrichment}.
 *   - write: the merged JAK-185 {@link EnrichmentFieldWriteBackService}.
 *
 * Error handling (the retry contract):
 *   - transient REAPI 429/5xx / network → RETHROW so BullMQ retries (honoring the
 *     queue's exponential backoff). We never swallow a transient error.
 *   - a valid REAPI no-match → TERMINAL `not_found`: log + finish cleanly, no write,
 *     no retry.
 *   - no resolvable address → TERMINAL `no_address`: nothing looked up/written.
 *   - a permanent REAPI HTTP error (4xx≠429) → {@link UnrecoverableError} so the job
 *     fails WITHOUT pointless retries.
 * A per-job failure only fails that job; the worker keeps consuming.
 */
import { UnrecoverableError } from "bullmq";
import { inject, injectable } from "tsyringe";
import { RealEstateApiDao } from "../../data/RealEstateApiDao";
import { RealEstateApiPropertyDetail } from "../../types/RealEstateApi";
import { formatPropertyDetailEnrichment } from "./PropertyDetailEnrichmentFormatter";
import { ReapiPropertyDetailSubject } from "./AutoEnrichmentTypes";
import { EnrichmentFieldWriteBackService } from "./EnrichmentFieldWriteBackService";
import { AutoEnrichmentJobPayload } from "./AutoEnrichmentQueueTypes";
import { AutoEnrichmentOutcome } from "./AutoEnrichmentWorkerTypes";
import { AddressLlmParser } from "./AddressLlmParser";
import {
  EnrichmentAddressParts,
  RawAddressFields,
  buildAddressParts,
  displayAddress,
} from "./addressParts";

/** Loose HTTP-error shape we read to classify transient vs permanent REAPI errors. */
interface HttpLikeError {
  response?: { status?: number };
  status?: number;
}

@injectable()
export class AutoEnrichmentWorker {
  constructor(
    @inject(RealEstateApiDao) private readonly realEstate: RealEstateApiDao,
    @inject(EnrichmentFieldWriteBackService)
    private readonly writeBack: EnrichmentFieldWriteBackService,
    @inject(AddressLlmParser) private readonly addressLlm: AddressLlmParser
  ) {}

  /**
   * Run the enrichment pipeline for one job. Returns a terminal outcome, or THROWS
   * to signal a retry (transient) / non-retryable failure (permanent).
   */
  async process(payload: AutoEnrichmentJobPayload): Promise<AutoEnrichmentOutcome> {
    const { locationId, contactId } = payload;

    // 1. Resolve CLEAN, STRUCTURED address parts (structured fields first, then
    //    rawContact). We pass fields straight to REAPI — no lossy flatten→reparse —
    //    so a dirty zip ("z:85335") or a missing state can't defeat the lookup.
    const parts = await this.resolveAddressParts(payload);
    if (!parts) {
      console.warn(
        `🏚️ [auto-enrichment] ${locationId}/${contactId}: no resolvable address — skipping`
      );
      return { status: "no_address", locationId, contactId };
    }
    const address = displayAddress(parts); // for logs only

    // 2. REAPI PropertyDetail lookup. Transient errors propagate (retry); a valid
    //    no-match returns null (terminal).
    let subject: RealEstateApiPropertyDetail | null;
    try {
      subject = await this.realEstate.getPropertyDetailSubjectByParts(parts);
    } catch (err) {
      if (this.isTransient(err)) {
        console.warn(
          `🔁 [auto-enrichment] ${locationId}/${contactId}: transient REAPI error — retrying`
        );
        throw err; // BullMQ retries with backoff
      }
      // Permanent HTTP error (bad request / auth / etc.) — don't retry forever.
      throw new UnrecoverableError(
        `REAPI permanent error for ${locationId}/${contactId}: ${this.message(err)}`
      );
    }

    if (!subject) {
      console.log(
        `🔎 [auto-enrichment] ${locationId}/${contactId}: no REAPI match for "${address}" — done`
      );
      return { status: "not_found", locationId, contactId };
    }

    // 3. Format the subject → logical fields (JAK-184). 4. Overwrite the GHL
    //    custom fields (JAK-185). Re-processing the same contact just overwrites.
    const fields = formatPropertyDetailEnrichment(
      subject as unknown as ReapiPropertyDetailSubject
    );
    const result = await this.writeBack.writeEnrichmentFields(locationId, contactId, fields);

    console.log(
      `✅ [auto-enrichment] ${locationId}/${contactId}: wrote ${result.written.length} field(s)` +
        (result.skipped.length ? `, skipped ${result.skipped.length}` : "")
    );
    return {
      status: "enriched",
      locationId,
      contactId,
      written: result.written.length,
      skipped: result.skipped.length,
    };
  }

  /**
   * Resolve CLEAN, STRUCTURED address parts for the REAPI lookup. Prefers the job's
   * structured `address` fields; falls back to fields on `rawContact`. Delegates
   * sanitization to {@link buildAddressParts} (bare-zip, state normalize/zip-derive)
   * — which, since JAK-196, ALSO de-pollutes a line1 carrying the whole address
   * (comma-split, or a known-field strip) so a "828 Pearson Oaks Dr, collierville,
   * TN, 38017" street field yields the CLEAN "828 Pearson Oaks Dr" REGARDLESS of
   * whether the structured city/state/zip are also filled.
   *
   * JAK-196: when EVERY deterministic path is exhausted but a line1 candidate
   * exists (the no-comma blob "828 Pearson Oaks Dr collierville TN 38017" with the
   * structured fields empty — which no heuristic can split), we ask the LLM parser
   * to extract the parts, re-validated through the same JAK-193 rules. Only when
   * that too yields nothing do we return null → `no_address`.
   */
  private async resolveAddressParts(
    payload: AutoEnrichmentJobPayload
  ): Promise<EnrichmentAddressParts | null> {
    const structured: RawAddressFields = {
      line1: this.str(payload.address?.line1),
      city: this.str(payload.address?.city),
      state: this.str(payload.address?.state),
      postal: this.str(payload.address?.postal),
    };
    const fromStructured = buildAddressParts(structured);
    if (fromStructured) return fromStructured;

    let rawFields: RawAddressFields | undefined;
    const raw = payload.rawContact;
    if (raw) {
      rawFields = {
        line1:
          this.str(raw.address1) ??
          this.str(raw.line1) ??
          this.str(raw.street) ??
          this.str(raw.address),
        city: this.str(raw.city),
        state: this.str(raw.state),
        postal:
          this.str(raw.postalCode) ??
          this.str(raw.postal_code) ??
          this.str(raw.zip) ??
          this.str(raw.zipCode),
      };
      const fromRawFields = buildAddressParts(rawFields);
      if (fromRawFields) return fromRawFields;
    }

    // Deterministic paths exhausted — the LLM robustly parses a line1 blob no
    // heuristic can split (structured hints, when present, stay authoritative).
    const best = structured.line1 ? structured : rawFields;
    if (best?.line1) {
      return this.addressLlm.parse(best.line1, best);
    }
    return null;
  }

  /**
   * A transient REAPI error worth retrying: a 429 or 5xx HTTP status, or a
   * network/timeout error with no HTTP status at all (mirrors the retry policy in
   * {@link import("../api/GhlApiClient").GhlApiClient}). A 4xx≠429 is permanent.
   */
  private isTransient(err: unknown): boolean {
    const status = this.statusOf(err);
    if (status === undefined) return true; // network / timeout — no response
    return status === 429 || (status >= 500 && status <= 599);
  }

  private statusOf(err: unknown): number | undefined {
    const e = err as HttpLikeError | null;
    const status = e?.response?.status ?? e?.status;
    return typeof status === "number" ? status : undefined;
  }

  private message(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }

  /** A trimmed non-empty string from an unknown value, or undefined. */
  private str(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
}
