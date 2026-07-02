import { UnrecoverableError } from "bullmq";
import { inject, injectable } from "tsyringe";
import { GhlApiClient, GhlApiError } from "../api/GhlApiClient";
import { GhlContact } from "../api/GhlApiTypes";
import { GhlConnectionService } from "../connections/GhlConnectionService";
import {
  buildLocationFieldIdMap,
  mapEnrichmentToCustomFields,
} from "../fieldMapping/EnrichmentFieldMapper";
import { GhlCustomFieldStore } from "../lifecycle/GhlCustomFieldStore";
import { RealEstateApiDao } from "../../data/RealEstateApiDao";
import { EnrichmentJobPayload } from "../../types/LeadEnrichment";
import { EnrichmentCostPlan } from "../metering/CreditCosts";
import { CreditService } from "../metering/CreditService";
import { buildEnrichmentNote } from "./EnrichmentNote";
import {
  EnrichmentEventStatus,
  GhlEnrichmentEventStore,
} from "./GhlEnrichmentEventStore";

/** What one processed job resolved to (mirrors the recorded event status). */
export interface EnrichmentOutcome {
  status: EnrichmentEventStatus;
  /** Short, secret-free reason — present for skips/failures. */
  detail?: string;
}

/** Log/record context for a single contact. Never carries a credential. */
interface JobContext {
  locationId: string;
  contactId: string;
}

/**
 * The enrichment worker (JAK-107) — the keystone that ties the pipeline together.
 *
 * It consumes one BullMQ enrichment job (enqueued by the JAK-106 webhook) and,
 * for that contact:
 *   1. short-circuits if the contact is already enriched (idempotency, via the
 *      JAK-107 events store) — safe under GHL webhook retries / re-delivery;
 *   2. loads the per-location connection from the JAK-102 store, skipping an
 *      unknown or inactive (uninstalled) location;
 *   3. fetches the contact via the JAK-104 {@link GhlApiClient};
 *   4. runs Jake's EXISTING enrichment engine ({@link RealEstateApiDao}) — the
 *      parked MVP property/skip-trace logic, reused, not rebuilt;
 *   5. maps the result with the JAK-108 field mapper against the location's
 *      provisioned `ghl_custom_fields` id map;
 *   6. writes the values back and drops a "Jake Enrichment" summary note;
 *   7. records the outcome for idempotency + metering.
 *
 * SPEC §8 write-safety is enforced inside {@link GhlApiClient} (dev echoes/skips
 * real writes; staging/prod write), so this worker never re-derives the stage.
 *
 * Failure handling is deliberately minimal (JAK-111 hardens it): transient GHL
 * failures re-throw so BullMQ retries with backoff and eventually dead-letters;
 * permanent failures throw {@link UnrecoverableError} to skip straight to the
 * failed set; expected non-error outcomes are recorded as `skipped` and complete
 * cleanly. The decrypted Bearer token is NEVER logged.
 */
@injectable()
export class GhlEnrichmentWorker {
  constructor(
    @inject(GhlApiClient) private readonly client: GhlApiClient,
    @inject(GhlConnectionService) private readonly connections: GhlConnectionService,
    @inject(GhlCustomFieldStore) private readonly fields: GhlCustomFieldStore,
    @inject(RealEstateApiDao) private readonly realEstate: RealEstateApiDao,
    @inject(GhlEnrichmentEventStore) private readonly events: GhlEnrichmentEventStore,
    @inject(CreditService) private readonly credits: CreditService
  ) {}

  /**
   * Process one enrichment job. Returns the outcome for `enriched`/`skipped`;
   * throws (for BullMQ retry / dead-letter) on a real failure.
   */
  async process(payload: EnrichmentJobPayload): Promise<EnrichmentOutcome> {
    const { contact_id: contactId, location_id: locationId } = payload;

    // This worker is the multi-tenant path — it requires a location. The queue
    // routes single-tenant MVP jobs (no location) to the legacy service instead,
    // so this is a guard, not an expected branch.
    if (!locationId) {
      throw new UnrecoverableError("enrichment job missing location_id");
    }
    const ctx: JobContext = { locationId, contactId };

    // 1. Idempotency. A prior `enriched` row means a duplicate / retried delivery
    //    — do nothing. A prior `failed`/`skipped` row is allowed to reprocess.
    const existing = await this.events.findByContact(locationId, contactId);
    if (existing?.status === "enriched") {
      this.log("info", "already enriched — skipping duplicate", ctx);
      return { status: "skipped", detail: "already_enriched" };
    }

    // 2. Resolve the location. Unknown or inactive (uninstalled) → record + skip;
    //    never an error, so the job completes and GHL/BullMQ stop retrying it.
    const conn = await this.connections.getByLocationId(locationId);
    if (!conn) {
      return this.skip(ctx, "no_connection");
    }
    if (conn.status !== "active") {
      return this.skip(ctx, "location_inactive");
    }

    // 3. Load the contact (JAK-104 client, per-location auth).
    let contact: GhlContact | null;
    try {
      contact = await this.client.getContact(locationId, contactId);
    } catch (err) {
      return this.fail(err, ctx, "load contact");
    }
    if (!contact) {
      return this.skip(ctx, "contact_not_found");
    }

    // 4. Resolve the address. Prefer the one the webhook carried; otherwise build
    //    it from the contact GHL returned. No address → nothing to enrich.
    const address = payload.full_address?.trim() || this.addressFromContact(contact);
    if (!address) {
      return this.skip(ctx, "no_address");
    }

    // 5. Metering gate (JAK-109). BEFORE any paid work, confirm the location has
    //    enough credits. If not, record `credit_blocked` and skip — we never
    //    enrich for free and never half-charge. `skipTrace` is false on this path
    //    (the enrichment engine doesn't skip-trace yet); when it does, flipping
    //    the flag applies the extra cost automatically via the config-driven
    //    credit costs — no other change here.
    const plan: EnrichmentCostPlan = { skipTrace: false };
    if (!(await this.credits.hasSufficientCredits(locationId, plan))) {
      return this.creditBlocked(ctx, plan);
    }

    // 6. Run Jake's existing enrichment engine (reuse, don't rebuild).
    const result = await this.realEstate.getEnrichmentDataByAddress(address);
    if (!result) {
      // Nothing to write back — the customer gets no value, so we don't charge
      // (the external lookup cost is ours to absorb). Recorded as a plain skip.
      return this.skip(ctx, "no_property_match");
    }

    // 7. Map to the location's provisioned custom fields (JAK-108 × JAK-105).
    const rows = await this.fields.listByLocation(locationId);
    const customFields = mapEnrichmentToCustomFields(result, buildLocationFieldIdMap(rows));

    // 8. Write back + summary note. Both go through the client's §8 write-safety
    //    gate (dev echoes/skips). An empty payload means the location has no Jake
    //    fields provisioned yet — note still goes out; nothing to update.
    try {
      if (customFields.length > 0) {
        await this.client.updateContactCustomFields(locationId, contactId, customFields);
      } else {
        this.log("warn", "no provisioned fields to write — skipping custom-field update", ctx);
      }
      await this.client.createNote(locationId, contactId, buildEnrichmentNote(result));
    } catch (err) {
      return this.fail(err, ctx, "write-back");
    }

    // 9. Charge for the delivered enrichment, atomically (JAK-109). The pre-check
    //    (step 5) already confirmed funds; this deducts + writes the ledger. On
    //    the rare concurrent-drain race the pre-check can't catch, we log loudly
    //    but still record the enrichment — value was delivered — and charge 0.
    const charge = await this.credits.chargeForEnrichment({ locationId, contactId, plan });
    const charged = charge.ok ? this.credits.costOf(plan) : 0;
    if (!charge.ok) {
      this.log(
        "error",
        `enriched but charge failed — insufficient credits at commit ` +
          `(had ${charge.balance}, needed ${charge.required})`,
        ctx
      );
    }

    // 10. Record success for idempotency + metering. cost_estimate = credits
    //     actually charged.
    await this.events.record({
      location_id: locationId,
      contact_id: contactId,
      status: "enriched",
      cost_estimate: charged,
    });
    this.log("info", `enriched (charged ${charged} credits)`, ctx);
    return { status: "enriched" };
  }

  /**
   * Record that the location can't afford this enrichment and complete the job
   * cleanly (JAK-109). Not an error and not a plain skip: no paid work ran, and
   * the row reprocesses once credits are granted. Never enriches for free.
   */
  private async creditBlocked(
    ctx: JobContext,
    plan: EnrichmentCostPlan
  ): Promise<EnrichmentOutcome> {
    const required = this.credits.costOf(plan);
    await this.events.record({
      location_id: ctx.locationId,
      contact_id: ctx.contactId,
      status: "credit_blocked",
      detail: `insufficient_credits (needed ${required})`,
    });
    this.log("warn", `credit-blocked — needs ${required} credits`, ctx);
    return { status: "credit_blocked", detail: "insufficient_credits" };
  }

  /** Record a permanent, non-error outcome and complete the job cleanly. */
  private async skip(ctx: JobContext, reason: string): Promise<EnrichmentOutcome> {
    await this.events.record({
      location_id: ctx.locationId,
      contact_id: ctx.contactId,
      status: "skipped",
      detail: reason,
    });
    this.log("info", `skipped (${reason})`, ctx);
    return { status: "skipped", detail: reason };
  }

  /**
   * Record a failure and re-throw so BullMQ handles the retry policy. Transient
   * GHL failures throw as-is (retried with backoff, then dead-lettered);
   * permanent ones throw {@link UnrecoverableError} to fail fast. Detail is a
   * short, secret-free summary — never the Bearer token.
   */
  private async fail(err: unknown, ctx: JobContext, operation: string): Promise<never> {
    const summary = this.errorSummary(err);
    const transient = this.isTransient(err);
    await this.events.record({
      location_id: ctx.locationId,
      contact_id: ctx.contactId,
      status: "failed",
      detail: `${operation}: ${summary}`.slice(0, 500),
    });

    if (transient) {
      this.log("warn", `${operation} failed (transient, will retry): ${summary}`, ctx);
      throw err instanceof Error ? err : new Error(summary);
    }
    this.log("error", `${operation} failed (permanent): ${summary}`, ctx);
    throw new UnrecoverableError(`${operation} failed: ${summary}`);
  }

  /**
   * Transient = worth retrying: network/timeout (no status), rate-limit (429),
   * or server error (5xx). A specific 4xx from GHL is permanent. Unknown,
   * non-API errors default to transient so a blip (e.g. the DB) gets another go.
   */
  private isTransient(err: unknown): boolean {
    if (err instanceof GhlApiError) {
      const status = err.status;
      if (status === undefined) return true;
      if (status === 429) return true;
      return status >= 500 && status <= 599;
    }
    return true;
  }

  /** A short, SECRET-FREE description of an error for logs + the event detail. */
  private errorSummary(err: unknown): string {
    if (err instanceof GhlApiError) {
      return err.status ? `GHL ${err.status}` : err.message;
    }
    return err instanceof Error ? err.message : "unknown error";
  }

  /**
   * Build a single-line address from a GHL contact, in the
   * "street, city, STATE zip" shape the enrichment engine's parser expects.
   * Returns undefined if there isn't enough to look up.
   */
  private addressFromContact(contact: GhlContact): string | undefined {
    const street = (contact.address1 ?? "").trim();
    const city = (contact.city ?? "").trim();
    const state = (contact.state ?? "").trim();
    const zip = (contact.postalCode ?? "").trim();

    // Need at least a street line plus something to disambiguate it.
    if (!street || (!zip && !city)) return undefined;

    const locality = [city, [state, zip].filter(Boolean).join(" ").trim()]
      .filter(Boolean)
      .join(", ");
    return locality ? `${street}, ${locality}` : street;
  }

  /** Structured, secret-free log line. The Bearer token never reaches here. */
  private log(level: "info" | "warn" | "error", message: string, ctx: JobContext): void {
    const line = `🧩 [jak-107] ${message} — location=${ctx.locationId} contact=${ctx.contactId}`;
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  }
}
