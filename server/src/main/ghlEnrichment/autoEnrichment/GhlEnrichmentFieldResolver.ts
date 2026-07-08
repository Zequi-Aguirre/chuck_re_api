/**
 * GHL enrichment field-id resolver + per-location cache (JAK-185, epic JAK-180).
 *
 * Auto-discovers the GHL custom-field IDS BY NAME so we never hand-enter ~20 ids
 * per sub-account. It fetches the location's custom-field catalog via the JAK-104
 * {@link GhlApiClient} (per-location stored creds), builds a normalized
 * name → id map, and CACHES it per location.
 *
 * Cache invalidation is demand-driven: {@link resolveFieldIds} takes the names the
 * caller needs this write and, if any is absent from a CACHED map, refetches ONCE
 * (Eric may have just created that field via his prompt) and replaces the cache.
 * A freshly-fetched map is trusted as-is — a name still missing after a fetch is a
 * field that genuinely doesn't exist yet, which the write-back skips gracefully.
 *
 * Read-only: `listCustomFields` is a GET, so it runs in every environment (only
 * writes are env-gated). Holds no credentials — those live in the JAK-102 store.
 */
import { inject, injectable } from "tsyringe";
import { GhlApiClient } from "../api/GhlApiClient";
import { normalizeFieldName } from "./AutoEnrichmentFieldCatalog";

/** Normalized GHL field name → GHL field id, for one location. */
export type FieldIdMap = ReadonlyMap<string, string>;

@injectable()
export class GhlEnrichmentFieldResolver {
  /** Per-location cache of the discovered name → id map. */
  private readonly cacheByLocation = new Map<string, FieldIdMap>();

  constructor(@inject(GhlApiClient) private readonly api: GhlApiClient) {}

  /**
   * Resolve the normalized name → id map for a location, refetching once if a
   * required name is missing from a cached map. `requiredNames` are the RAW GHL
   * display names the caller intends to write (normalized internally).
   */
  async resolveFieldIds(
    locationId: string,
    requiredNames: readonly string[]
  ): Promise<FieldIdMap> {
    const cached = this.cacheByLocation.get(locationId);
    const map = cached ?? (await this.fetchAndCache(locationId));

    // Only a CACHED map is worth rechecking — a fresh fetch is already current.
    if (cached) {
      const anyMissing = requiredNames.some(
        (name) => !map.has(normalizeFieldName(name))
      );
      if (anyMissing) return this.fetchAndCache(locationId);
    }
    return map;
  }

  /** Drop a location's cached catalog (e.g. after an uninstall/reinstall). */
  invalidate(locationId: string): void {
    this.cacheByLocation.delete(locationId);
  }

  /** Fetch the location's custom-field catalog, (re)build + cache the name→id map. */
  private async fetchAndCache(locationId: string): Promise<FieldIdMap> {
    const fields = await this.api.listCustomFields(locationId);
    const map = new Map<string, string>();
    for (const field of fields) {
      const name = typeof field?.name === "string" ? normalizeFieldName(field.name) : "";
      if (name && field.id) map.set(name, field.id); // later duplicate wins
    }
    this.cacheByLocation.set(locationId, map);
    return map;
  }
}
