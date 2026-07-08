/**
 * Auto-enrichment worker / processor (JAK-183, epic JAK-180).
 *
 * The integration piece that ties the merged parts together. For ONE dequeued job
 * it runs the full pipeline:
 *
 *   job → resolve+normalize the property address → REAPI PropertyDetail lookup
 *       → PropertyDetailEnrichmentFormatter (JAK-184) → writeEnrichmentFields (JAK-185)
 *
 * It is a pure processor: {@link AutoEnrichmentQueueService} owns the BullMQ Worker
 * lifecycle (concurrency, retry/backoff, Redis) and calls {@link process} per job.
 * Keeping the pipeline here — free of BullMQ — makes it unit-testable with the DAO
 * + write-back mocked (no real REAPI/GHL).
 *
 * Reuse, not reinvention:
 *   - address: {@link normalizeInboundAddress} (the SMS report path's normalizer).
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
import { normalizeInboundAddress } from "../../util/address";
import { formatPropertyDetailEnrichment } from "./PropertyDetailEnrichmentFormatter";
import { ReapiPropertyDetailSubject } from "./AutoEnrichmentTypes";
import { EnrichmentFieldWriteBackService } from "./EnrichmentFieldWriteBackService";
import { AutoEnrichmentJobPayload, AutoEnrichmentAddress } from "./AutoEnrichmentQueueTypes";
import { AutoEnrichmentOutcome } from "./AutoEnrichmentWorkerTypes";

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
    private readonly writeBack: EnrichmentFieldWriteBackService
  ) {}

  /**
   * Run the enrichment pipeline for one job. Returns a terminal outcome, or THROWS
   * to signal a retry (transient) / non-retryable failure (permanent).
   */
  async process(payload: AutoEnrichmentJobPayload): Promise<AutoEnrichmentOutcome> {
    const { locationId, contactId } = payload;

    // 1. Resolve + normalize the address (structured first, then rawContact).
    const address = this.resolveAddress(payload);
    if (!address) {
      console.warn(
        `🏚️ [auto-enrichment] ${locationId}/${contactId}: no resolvable address — skipping`
      );
      return { status: "no_address", locationId, contactId };
    }

    // 2. REAPI PropertyDetail lookup. Transient errors propagate (retry); a valid
    //    no-match returns null (terminal).
    let subject: RealEstateApiPropertyDetail | null;
    try {
      subject = await this.realEstate.getPropertyDetailSubjectByAddress(address);
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
   * Resolve a single-line, normalized address for the REAPI lookup. Prefers the
   * job's structured `address`; falls back to fields on `rawContact`. Runs the
   * candidate through {@link normalizeInboundAddress} (the shared normalizer),
   * returning null when nothing address-like is present.
   */
  private resolveAddress(payload: AutoEnrichmentJobPayload): string | null {
    const fromStructured = this.addressFromParts(payload.address);
    if (fromStructured) {
      const normalized = normalizeInboundAddress(fromStructured);
      if (normalized) return normalized;
    }

    const raw = payload.rawContact;
    if (raw) {
      const parts = this.addressFromRawContact(raw);
      const candidate = this.addressFromParts(parts) ?? this.str(raw.address);
      if (candidate) return normalizeInboundAddress(candidate);
    }
    return null;
  }

  /** Build "line1, city, ST zip" from address parts, or null when line1 is absent. */
  private addressFromParts(address: AutoEnrichmentAddress | undefined): string | null {
    if (!address) return null;
    const line1 = this.str(address.line1);
    if (!line1) return null; // no street → nothing REAPI can key on
    const city = this.str(address.city);
    const state = this.str(address.state);
    const postal = this.str(address.postal);
    const tail = [state, postal].filter(Boolean).join(" ");
    return [line1, city, tail].filter((p) => p && p.length > 0).join(", ");
  }

  /** Pull address parts out of a loose GHL contact body (tolerant field names). */
  private addressFromRawContact(raw: Record<string, unknown>): AutoEnrichmentAddress {
    return {
      line1: this.str(raw.address1) ?? this.str(raw.line1) ?? this.str(raw.street),
      city: this.str(raw.city),
      state: this.str(raw.state),
      postal:
        this.str(raw.postalCode) ??
        this.str(raw.postal_code) ??
        this.str(raw.zip) ??
        this.str(raw.zipCode),
    };
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
