import { injectable } from "tsyringe";
import { GhlApiClient, GhlConnectionUnavailableError } from "../api/GhlApiClient";
import { GhlCustomField } from "../api/GhlApiTypes";
import { GhlEnrichmentConfig } from "../config/GhlEnrichmentConfig";
import { ExternalActionGuard } from "../../safety/ExternalActionGuard";
import { normalizeFieldKey } from "../lifecycle/JakeCustomFields";

/**
 * Sync a text-Jake customer into the Jake GHL sub-account (JAK-147).
 *
 * Onboarding a texter = find-or-create their contact in the ONE shared "Jake"
 * sub-account and flip the pre-existing "text Jake" approval custom field on, so
 * the GHL automation that forwards their inbound texts to Jake starts firing.
 *
 * Design:
 *  - The Jake sub-account's location id is the EXISTING gateway location config
 *    (JAKE_GATEWAY_LOCATION_ID) — no new Doppler key. Its credentials are
 *    resolved from the JAK-102 connection store via the JAK-104 {@link GhlApiClient}
 *    (decrypted key + base_url), never a master key here.
 *  - The "text Jake" field ALREADY EXISTS; we look it up by name/key
 *    (case-insensitively) and cache its id per location. We NEVER create it — a
 *    missing field surfaces a clear, non-crashing error to the admin.
 *  - WRITE-SAFETY (JAK-110): off prod/staging we skip the whole sync (no read,
 *    no write) and tell the admin plainly. The client's write gate is the
 *    backstop underneath, so a real create/update can't happen in dev.
 *  - IDEMPOTENT: the contact is upserted by phone, so re-saving the same
 *    customer updates the same contact instead of duplicating it.
 */
@injectable()
export class TextCustomerGhlSyncService {
  /** Per-location cache of the resolved "text Jake" field id (service is a singleton). */
  private readonly fieldIdCache = new Map<string, string>();

  constructor(
    private readonly client: GhlApiClient,
    private readonly config: GhlEnrichmentConfig,
    private readonly guard: ExternalActionGuard
  ) {}

  /**
   * Onboard/refresh a customer in the Jake sub-account: find-or-create their
   * contact by phone, write name + email, and set "text Jake" = approved. Never
   * throws — GHL problems come back as a friendly {@link TextCustomerSyncResult}
   * so the customer's DB row (the billing identity) is never lost to a sync hiccup.
   */
  async syncCustomer(input: TextCustomerSyncInput): Promise<TextCustomerSyncResult> {
    const locationId = this.jakeLocationId();
    if (!locationId) {
      return {
        status: "not_connected",
        ghlContactId: null,
        message:
          "The Jake sub-account isn't set up yet, so this customer wasn't synced to GoHighLevel.",
      };
    }

    // JAK-110 write-safety: never touch a real GHL sub-account off prod/staging.
    // Skip the sync entirely (no read, no write) and say so. The GhlApiClient
    // write gate is the backstop if a write is ever attempted anyway.
    if (!this.guard.liveActionsAllowed) {
      this.guard.echoSkipped("text-customer GHL sync", `Jake sub-account ${locationId}`);
      return {
        status: "skipped",
        ghlContactId: null,
        message: "Saved. Syncing to GoHighLevel runs in staging and production only.",
      };
    }

    try {
      const fieldId = await this.resolveTextJakeFieldId(locationId);
      if (!fieldId) {
        return {
          status: "field_not_found",
          ghlContactId: null,
          message:
            "Saved, but the “text Jake” custom field wasn’t found in this sub-account — approval couldn’t be set.",
        };
      }

      const contact = await this.client.upsertContact(locationId, {
        phone: input.phone,
        firstName: input.firstName,
        lastName: input.lastName,
        email: input.email,
        customFields: [{ id: fieldId, value: APPROVED_VALUE }],
      });

      return {
        status: "synced",
        ghlContactId: contact?.id ?? null,
        message: "Synced to GoHighLevel and approved to text Jake.",
      };
    } catch (err) {
      return this.classifyError(err);
    }
  }

  /**
   * Look up the existing Jake-sub-account contact for a phone (JAK-147 "find
   * contact") so the admin form can prefill name/email. Returns a friendly,
   * never-throwing result: found, not-found (will be created on save), or a
   * reachability message.
   */
  async findContact(phone: string): Promise<FindContactResult> {
    const locationId = this.jakeLocationId();
    if (!locationId) {
      return {
        found: false,
        contact: null,
        message: "The Jake sub-account isn't set up yet.",
      };
    }
    try {
      const contact = await this.client.findContactByPhone(locationId, phone);
      if (!contact) {
        return {
          found: false,
          contact: null,
          message: "No GoHighLevel contact on that number yet — one will be created when you save.",
        };
      }
      return {
        found: true,
        contact: {
          ghlContactId: contact.id,
          firstName: contact.firstName ?? null,
          lastName: contact.lastName ?? null,
          email: contact.email ?? null,
        },
        message: "Found an existing GoHighLevel contact.",
      };
    } catch (err) {
      return { found: false, contact: null, message: this.classifyError(err).message };
    }
  }

  /** The Jake sub-account's GHL location id (existing gateway config; no new key). */
  private jakeLocationId(): string {
    return (this.config.gateway.locationId || "").trim();
  }

  /**
   * Resolve (and cache per location) the GHL id of the "text Jake" field by
   * matching the location's custom fields by name/key, case-insensitively. Never
   * creates the field — returns null when it isn't present so the caller can
   * surface a clear error.
   */
  private async resolveTextJakeFieldId(locationId: string): Promise<string | null> {
    const cached = this.fieldIdCache.get(locationId);
    if (cached) return cached;

    const fields = await this.client.listCustomFields(locationId);
    const match = fields.find((f) => isTextJakeField(f));
    if (!match?.id) return null;

    this.fieldIdCache.set(locationId, match.id);
    return match.id;
  }

  /** Map a GHL/connection failure to a friendly, non-technical sync result. */
  private classifyError(err: unknown): TextCustomerSyncResult {
    if (err instanceof GhlConnectionUnavailableError) {
      return {
        status: "not_connected",
        ghlContactId: null,
        message:
          "Couldn’t reach the Jake sub-account in GoHighLevel — check that it’s connected.",
      };
    }
    return {
      status: "error",
      ghlContactId: null,
      message: "Couldn’t sync to GoHighLevel just now. The customer is saved; try again shortly.",
    };
  }
}

/** The value that marks a contact APPROVED to text Jake. The field is a
 * boolean/approval field; GHL takes a raw `true` for a checkbox/approval value,
 * mirroring how the enrichment write-back sets its CHECKBOX fields (JAK-108). */
const APPROVED_VALUE = true;

/** The human name of the pre-existing approval field, as shown in GHL. */
export const TEXT_JAKE_FIELD_NAME = "text Jake";

/** Normalized match key — lowercased, non-alphanumerics stripped ("textjake"). */
const TEXT_JAKE_FIELD_MATCH = normalizeName(TEXT_JAKE_FIELD_NAME);

/** Lowercase + strip non-alphanumerics so "text Jake" / "Text_Jake" / "textJake" all match. */
function normalizeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** True when a GHL field is the "text Jake" approval field (by name OR field key). */
function isTextJakeField(field: GhlCustomField): boolean {
  const byName = normalizeName(field.name ?? "");
  const byKey = field.fieldKey ? normalizeName(normalizeFieldKey(field.fieldKey)) : "";
  return byName === TEXT_JAKE_FIELD_MATCH || byKey === TEXT_JAKE_FIELD_MATCH;
}

/** The identity + profile we push to the Jake sub-account for a text customer. */
export interface TextCustomerSyncInput {
  phone: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
}

/** Outcome of a sync, one status + a friendly line for the admin UI. */
export type TextCustomerSyncStatus =
  | "synced"
  | "skipped"
  | "field_not_found"
  | "not_connected"
  | "error";

export interface TextCustomerSyncResult {
  status: TextCustomerSyncStatus;
  /** The GHL contact id when a live write resolved one; null otherwise. */
  ghlContactId: string | null;
  /** Friendly, non-technical line for the admin UI. */
  message: string;
}

/** A contact matched by the "find contact" lookup, trimmed to what the form needs. */
export interface TextCustomerContactMatch {
  ghlContactId: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
}

export interface FindContactResult {
  found: boolean;
  contact: TextCustomerContactMatch | null;
  message: string;
}
