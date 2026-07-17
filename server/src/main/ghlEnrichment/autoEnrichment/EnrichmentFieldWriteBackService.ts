/**
 * GHL custom-field write-back service (JAK-185, epic JAK-180).
 *
 * Takes a JAK-184 formatter result (logical field-name → value) and writes those
 * values onto a GHL contact's custom fields, OVERWRITING each field so the contact
 * stays current on every enrichment. Targets fields by GHL id (resolved by NAME
 * via {@link GhlEnrichmentFieldResolver}), so re-enriching the same contact
 * updates the same fields rather than duplicating anything.
 *
 * Overwrite semantics: we write every field the formatter PRODUCED a value for
 * (each `{ id, value }` overwrites that field). Fields the formatter omitted (no
 * data this run) are left untouched — matching the codebase's "never blank a value
 * we don't have" convention (see {@link GhlApiClient.upsertContact}) — so a run
 * with sparse data never wipes a previously-set field.
 *
 * Graceful degradation: a spec field with no matching GHL field on the location
 * (Eric hasn't created it yet) is SKIPPED + logged, never fatal — one missing
 * field must not fail the other 17. If NOTHING resolves, we skip the write call
 * entirely.
 *
 * Writes go through the JAK-104 client, whose single write-gate (JAK-110) echoes +
 * skips off prod/staging — dev never sends a real write to GHL.
 */
import { inject, injectable } from "tsyringe";
import { GhlApiClient } from "../api/GhlApiClient";
import { GhlCustomFieldValue } from "../api/GhlApiTypes";
import { AutoEnrichmentFields } from "./AutoEnrichmentTypes";
import {
  AUTO_ENRICHMENT_FIELDS,
  normalizeFieldKey,
  normalizeFieldName,
} from "./AutoEnrichmentFieldCatalog";
import { GhlEnrichmentFieldResolver } from "./GhlEnrichmentFieldResolver";

/** Outcome of a write-back, for the JAK-183 worker + logging + tests. */
export interface EnrichmentWriteBackResult {
  /** GHL field names written (overwritten) on the contact. */
  written: string[];
  /** Field names the formatter produced but that have NO matching GHL field on
   * the location — skipped gracefully, not written. */
  skipped: string[];
  /** Whether the GHL update call was actually issued (false = nothing to write). */
  didWrite: boolean;
}

@injectable()
export class EnrichmentFieldWriteBackService {
  constructor(
    @inject(GhlApiClient) private readonly api: GhlApiClient,
    @inject(GhlEnrichmentFieldResolver)
    private readonly resolver: GhlEnrichmentFieldResolver
  ) {}

  /**
   * Write the formatter's values onto a contact's custom fields for a location.
   * Resolves ids by name (auto-discovery + cache), overwrites each resolved field,
   * and skips (logs) any field with no GHL target. Pure orchestration — no
   * business rules about the values themselves (that's JAK-184).
   */
  async writeEnrichmentFields(
    locationId: string,
    contactId: string,
    fields: AutoEnrichmentFields
  ): Promise<EnrichmentWriteBackResult> {
    // Every catalog field the formatter produced a value for (omitted → skipped).
    const desired = AUTO_ENRICHMENT_FIELDS.map((def) => ({
      def,
      value: fields[def.key],
    })).filter((entry) => entry.value !== undefined);

    if (desired.length === 0) {
      return { written: [], skipped: [], didWrite: false };
    }

    const idsByName = await this.resolver.resolveFieldIds(
      locationId,
      desired.map((entry) => entry.def.name)
    );

    const customFields: GhlCustomFieldValue[] = [];
    const written: string[] = [];
    const skipped: string[] = [];
    for (const { def, value } of desired) {
      // JAK-194: resolve by the stable fieldKey first (drift-proof), then by name.
      const id =
        (def.fieldKey ? idsByName.get(normalizeFieldKey(def.fieldKey)) : undefined) ??
        idsByName.get(normalizeFieldName(def.name));
      if (!id) {
        skipped.push(def.name);
        console.warn(
          `⚠️ [enrichment write-back] location ${locationId}: no GHL custom field "${def.name}" — skipping`
        );
        continue;
      }
      customFields.push({ id, value });
      written.push(def.name);
    }

    if (customFields.length === 0) {
      console.warn(
        `⚠️ [enrichment write-back] location ${locationId} contact ${contactId}: no target fields resolved — nothing written`
      );
      return { written, skipped, didWrite: false };
    }

    // One PUT that OVERWRITES each field's value (targeted by id). Gated off-prod
    // at the client's write chokepoint, so dev never sends a real write.
    await this.api.updateContactCustomFields(locationId, contactId, customFields);
    return { written, skipped, didWrite: true };
  }
}
