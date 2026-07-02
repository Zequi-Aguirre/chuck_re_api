import { injectable } from "tsyringe";
import { GhlApiClient, GhlConnectionUnavailableError } from "../api/GhlApiClient";
import { GhlConnectionService } from "../connections/GhlConnectionService";
import { GhlCustomFieldRow, GhlCustomFieldStore } from "./GhlCustomFieldStore";
import {
  JAKE_CUSTOM_FIELDS,
  JakeCustomFieldDef,
  normalizeFieldKey,
} from "./JakeCustomFields";

/** How a single canonical field ended up after an install pass. */
export type ProvisionOutcome =
  /** Already in our store from a prior install — nothing to do (idempotent). */
  | "existing"
  /** A matching GHL field already existed; we recorded it without creating. */
  | "adopted"
  /** Newly created in GHL and recorded. */
  | "created"
  /** Off-prod write was skipped (SPEC §8 dev safety) — nothing recorded. */
  | "skipped";

export interface ProvisionedField {
  key: string;
  outcome: ProvisionOutcome;
  /** The provisioned row — present unless the write was skipped off-prod. */
  row?: GhlCustomFieldRow;
}

export interface InstallResult {
  locationId: string;
  fields: ProvisionedField[];
  welcomeNoteId: string | null;
}

/**
 * Install / uninstall lifecycle for a GHL sub-account (JAK-105).
 *
 * On install: auto-provision the canonical Jake custom fields
 * ({@link JAKE_CUSTOM_FIELDS}) in the location via {@link GhlApiClient}, persist
 * their per-location GHL ids in `ghl_custom_fields`, and drop a welcome note.
 * On uninstall: mark the location's connection inactive — the JAK-104 client
 * already refuses to serve inactive connections, so processing stops with no
 * extra guard here.
 *
 * IDEMPOTENT by design: a re-install never duplicates a field. Each canonical
 * field is skipped if we already recorded it, adopted if GHL already has a field
 * with the matching key, and only created when genuinely absent.
 *
 * Builds strictly on JAK-102 (connection store) + JAK-104 (API client) — it
 * extends them, it does not re-implement credential handling or HTTP.
 */
@injectable()
export class GhlInstallLifecycleService {
  constructor(
    private readonly client: GhlApiClient,
    private readonly connections: GhlConnectionService,
    private readonly fields: GhlCustomFieldStore
  ) {}

  /**
   * Provision fields + welcome note for a freshly-installed (or re-installed)
   * location. A previously-uninstalled connection is reactivated first, so
   * provisioning writes are allowed to flow through the client.
   *
   * @param locationId the installed GHL sub-account
   * @param opts.welcomeContactId optional contact to attach the welcome note to.
   *   GHL notes are contact-scoped, so with no target contact the welcome note is
   *   skipped (fields are still provisioned).
   */
  async install(
    locationId: string,
    opts: { welcomeContactId?: string } = {}
  ): Promise<InstallResult> {
    const conn = await this.connections.getByLocationId(locationId);
    if (!conn) {
      // No credentials on file — the JAK-102 connection must exist before we can
      // provision anything into the sub-account.
      throw new GhlConnectionUnavailableError(locationId, "no connection on file");
    }

    // Re-install after an uninstall: reactivate BEFORE provisioning, or the
    // client (JAK-104) would refuse the writes as inactive.
    if (conn.status !== "active") {
      await this.connections.updateConnection(locationId, { status: "active" });
    }

    const fields = await this.provisionFields(locationId);
    const welcomeNoteId = await this.dropWelcomeNote(locationId, opts.welcomeContactId);

    return { locationId, fields, welcomeNoteId };
  }

  /**
   * Uninstall: mark the location inactive so nothing else processes it. Returns
   * true if a connection was updated, false if the location was unknown. We keep
   * the provisioned-field rows — a re-install adopts them.
   */
  async uninstall(locationId: string): Promise<boolean> {
    const updated = await this.connections.updateConnection(locationId, {
      status: "inactive",
    });
    return updated !== null;
  }

  /**
   * Provision the canonical field set idempotently. Looks up what we've already
   * recorded and what GHL already has (by key) before creating anything, so a
   * re-install can never produce duplicate fields.
   */
  private async provisionFields(locationId: string): Promise<ProvisionedField[]> {
    // What we've already provisioned — the authoritative idempotency check.
    const existingRows = await this.fields.listByLocation(locationId);
    const recordedByKey = new Map(existingRows.map((r) => [r.jake_field_key, r]));

    // What GHL already has — lets us adopt fields created out-of-band or on a
    // prior install that failed to persist, instead of creating duplicates.
    const remoteFields = await this.client.listCustomFields(locationId);
    const remoteByKey = new Map(
      remoteFields
        .filter((f) => f.fieldKey)
        .map((f) => [normalizeFieldKey(f.fieldKey as string), f])
    );

    const results: ProvisionedField[] = [];
    for (const def of JAKE_CUSTOM_FIELDS) {
      results.push(await this.provisionOne(locationId, def, recordedByKey, remoteByKey));
    }
    return results;
  }

  private async provisionOne(
    locationId: string,
    def: JakeCustomFieldDef,
    recordedByKey: Map<string, GhlCustomFieldRow>,
    remoteByKey: Map<string, { id: string; fieldKey?: string }>
  ): Promise<ProvisionedField> {
    const recorded = recordedByKey.get(def.key);
    if (recorded) {
      return { key: def.key, outcome: "existing", row: recorded };
    }

    const remote = remoteByKey.get(def.key);
    if (remote) {
      const row = await this.fields.insert({
        location_id: locationId,
        jake_field_key: def.key,
        ghl_field_id: remote.id,
        ghl_field_key: remote.fieldKey ?? null,
        name: def.name,
        data_type: def.dataType,
      });
      return { key: def.key, outcome: "adopted", row };
    }

    const created = await this.client.createCustomField(locationId, {
      name: def.name,
      dataType: def.dataType,
      fieldKey: def.key,
    });
    if (!created) {
      // Off-prod write skipped by the client's SPEC §8 dev-safety guard — there's
      // no real field id to record. The field is provisioned for real in prod.
      return { key: def.key, outcome: "skipped" };
    }

    const row = await this.fields.insert({
      location_id: locationId,
      jake_field_key: def.key,
      ghl_field_id: created.id,
      ghl_field_key: created.fieldKey ?? null,
      name: def.name,
      data_type: def.dataType,
    });
    return { key: def.key, outcome: "created", row };
  }

  /**
   * Drop the install welcome note. GHL notes are contact-scoped, so this needs a
   * target contact; with none we skip it (returns null) rather than inventing a
   * location-level note GHL's API doesn't offer. Off-prod the client's dev-safety
   * guard also skips the write.
   */
  private async dropWelcomeNote(
    locationId: string,
    welcomeContactId?: string
  ): Promise<string | null> {
    if (!welcomeContactId) {
      return null;
    }
    const note = await this.client.createNote(
      locationId,
      welcomeContactId,
      WELCOME_NOTE_BODY
    );
    return note?.id ?? null;
  }
}

/** The install welcome note body. Plain text — GHL renders notes as-is. */
export const WELCOME_NOTE_BODY =
  "👋 Jake is installed. New contacts in this account will be automatically " +
  "enriched — owner details, sale history, and mortgage/foreclosure signals " +
  "appear on each contact's Jake fields. No manual lookups needed.";
