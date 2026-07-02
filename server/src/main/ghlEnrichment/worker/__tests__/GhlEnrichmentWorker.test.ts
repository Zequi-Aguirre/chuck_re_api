import { UnrecoverableError } from "bullmq";
import { mock, MockProxy } from "jest-mock-extended";
import { GhlApiClient, GhlApiError } from "../../api/GhlApiClient";
import { GhlContact } from "../../api/GhlApiTypes";
import { GhlConnectionService } from "../../connections/GhlConnectionService";
import { GhlConnection } from "../../connections/GhlConnectionTypes";
import { GhlCustomFieldRow, GhlCustomFieldStore } from "../../lifecycle/GhlCustomFieldStore";
import { JAKE_CUSTOM_FIELDS } from "../../lifecycle/JakeCustomFields";
import { RealEstateApiDao } from "../../../data/RealEstateApiDao";
import { EnrichmentResult } from "../../../types/LeadEnrichment";
import { ENRICHMENT_NOTE_HEADING } from "../EnrichmentNote";
import { GhlEnrichmentEventRow, GhlEnrichmentEventStore } from "../GhlEnrichmentEventStore";
import { GhlEnrichmentWorker } from "../GhlEnrichmentWorker";

const conn = (over: Partial<GhlConnection> = {}): GhlConnection => ({
  id: "conn-1",
  locationId: "loc_1",
  apiKey: "unit-test-plaintext-key",
  baseUrl: "https://services.leadconnectorhq.com",
  phoneNumbers: [],
  status: "active",
  createdAt: new Date("2026-07-01T00:00:00Z"),
  updatedAt: new Date("2026-07-01T00:00:00Z"),
  ...over,
});

const contact = (over: Partial<GhlContact> = {}): GhlContact => ({
  id: "ct_1",
  address1: "102 Southwind Dr",
  city: "Kathleen",
  state: "GA",
  postalCode: "31047",
  ...over,
});

const enrichment = (over: Partial<EnrichmentResult> = {}): EnrichmentResult => ({
  ownerName: "Jane Homeowner",
  isActiveListed: false,
  lastSalePrice: 250000,
  lastSoldDate: "2019-05-01",
  mortgageAmount: 180000,
  foreclosureActive: false,
  disqualify: false,
  disqualifyReasons: [],
  ...over,
});

/** A provisioned-field row for a canonical key (only fields the mapper reads). */
const fieldRow = (jakeKey: string): GhlCustomFieldRow => ({
  id: `row-${jakeKey}`,
  location_id: "loc_1",
  jake_field_key: jakeKey,
  ghl_field_id: `cf_${jakeKey}`,
  ghl_field_key: `contact.${jakeKey}`,
  name: jakeKey,
  data_type: "TEXT",
  created_at: new Date("2026-07-01T00:00:00Z"),
  modified_at: new Date("2026-07-01T00:00:00Z"),
  deleted_at: null,
});

const eventRow = (over: Partial<GhlEnrichmentEventRow> = {}): GhlEnrichmentEventRow => ({
  id: "evt-1",
  location_id: "loc_1",
  contact_id: "ct_1",
  status: "enriched",
  detail: null,
  cost_estimate: null,
  enriched_at: new Date("2026-07-01T00:00:00Z"),
  created_at: new Date("2026-07-01T00:00:00Z"),
  modified_at: new Date("2026-07-01T00:00:00Z"),
  ...over,
});

const JOB = { contact_id: "ct_1", location_id: "loc_1" };

describe("GhlEnrichmentWorker", () => {
  let client: MockProxy<GhlApiClient>;
  let connections: MockProxy<GhlConnectionService>;
  let fields: MockProxy<GhlCustomFieldStore>;
  let realEstate: MockProxy<RealEstateApiDao>;
  let events: MockProxy<GhlEnrichmentEventStore>;
  let worker: GhlEnrichmentWorker;

  beforeEach(() => {
    client = mock<GhlApiClient>();
    connections = mock<GhlConnectionService>();
    fields = mock<GhlCustomFieldStore>();
    realEstate = mock<RealEstateApiDao>();
    events = mock<GhlEnrichmentEventStore>();
    worker = new GhlEnrichmentWorker(client, connections, fields, realEstate, events);

    // Happy-path defaults: never processed, active connection, contact + property
    // found, every canonical field provisioned, writes succeed.
    events.findByContact.mockResolvedValue(null);
    events.record.mockImplementation(async (i) => eventRow(i as Partial<GhlEnrichmentEventRow>));
    connections.getByLocationId.mockResolvedValue(conn());
    client.getContact.mockResolvedValue(contact());
    realEstate.getEnrichmentDataByAddress.mockResolvedValue(enrichment());
    fields.listByLocation.mockResolvedValue(JAKE_CUSTOM_FIELDS.map((d) => fieldRow(d.key)));
    client.updateContactCustomFields.mockResolvedValue(undefined);
    client.createNote.mockResolvedValue({ id: "note_1", body: "x" });
  });

  describe("happy path", () => {
    it("fetches, enriches, writes back, notes, and records enriched", async () => {
      const outcome = await worker.process(JOB);

      expect(outcome.status).toBe("enriched");
      expect(client.getContact).toHaveBeenCalledWith("loc_1", "ct_1");
      expect(realEstate.getEnrichmentDataByAddress).toHaveBeenCalledWith(
        "102 Southwind Dr, Kathleen, GA 31047"
      );
      expect(client.updateContactCustomFields).toHaveBeenCalledTimes(1);
      const [loc, ct, customFields] = client.updateContactCustomFields.mock.calls[0];
      expect(loc).toBe("loc_1");
      expect(ct).toBe("ct_1");
      // All canonical fields map except jake_disqualify_reasons, which the JAK-108
      // mapper skips when the reasons list is empty (nothing to write).
      expect(customFields.length).toBe(JAKE_CUSTOM_FIELDS.length - 1);
      expect(client.createNote).toHaveBeenCalledWith(
        "loc_1",
        "ct_1",
        expect.stringContaining(ENRICHMENT_NOTE_HEADING)
      );
      expect(events.record).toHaveBeenCalledWith(
        expect.objectContaining({ location_id: "loc_1", contact_id: "ct_1", status: "enriched" })
      );
    });

    it("prefers the address carried on the job over the contact's", async () => {
      await worker.process({ ...JOB, full_address: "9 Job St, Miami, FL 33101" });
      expect(realEstate.getEnrichmentDataByAddress).toHaveBeenCalledWith(
        "9 Job St, Miami, FL 33101"
      );
    });
  });

  describe("idempotency", () => {
    it("skips a contact already enriched and does no work", async () => {
      events.findByContact.mockResolvedValue(eventRow({ status: "enriched" }));

      const outcome = await worker.process(JOB);

      expect(outcome).toEqual({ status: "skipped", detail: "already_enriched" });
      expect(client.getContact).not.toHaveBeenCalled();
      expect(client.updateContactCustomFields).not.toHaveBeenCalled();
      expect(events.record).not.toHaveBeenCalled();
    });

    it("reprocesses a contact whose prior attempt failed", async () => {
      events.findByContact.mockResolvedValue(eventRow({ status: "failed", enriched_at: null }));
      const outcome = await worker.process(JOB);
      expect(outcome.status).toBe("enriched");
      expect(client.updateContactCustomFields).toHaveBeenCalledTimes(1);
    });
  });

  describe("skips (permanent, non-error → completes cleanly)", () => {
    it("skips an unknown location", async () => {
      connections.getByLocationId.mockResolvedValue(null);
      const outcome = await worker.process(JOB);
      expect(outcome).toEqual({ status: "skipped", detail: "no_connection" });
      expect(client.getContact).not.toHaveBeenCalled();
      expect(events.record).toHaveBeenCalledWith(
        expect.objectContaining({ status: "skipped", detail: "no_connection" })
      );
    });

    it("skips an inactive (uninstalled) location", async () => {
      connections.getByLocationId.mockResolvedValue(conn({ status: "inactive" }));
      const outcome = await worker.process(JOB);
      expect(outcome).toEqual({ status: "skipped", detail: "location_inactive" });
      expect(client.getContact).not.toHaveBeenCalled();
    });

    it("skips when the contact no longer exists", async () => {
      client.getContact.mockResolvedValue(null);
      const outcome = await worker.process(JOB);
      expect(outcome).toEqual({ status: "skipped", detail: "contact_not_found" });
      expect(realEstate.getEnrichmentDataByAddress).not.toHaveBeenCalled();
    });

    it("skips when there is no usable address", async () => {
      client.getContact.mockResolvedValue(contact({ address1: "", city: "", state: "", postalCode: "" }));
      const outcome = await worker.process(JOB);
      expect(outcome).toEqual({ status: "skipped", detail: "no_address" });
      expect(realEstate.getEnrichmentDataByAddress).not.toHaveBeenCalled();
    });

    it("skips when the engine finds no property match", async () => {
      realEstate.getEnrichmentDataByAddress.mockResolvedValue(null);
      const outcome = await worker.process(JOB);
      expect(outcome).toEqual({ status: "skipped", detail: "no_property_match" });
      expect(client.updateContactCustomFields).not.toHaveBeenCalled();
    });
  });

  describe("write-back edge cases", () => {
    it("still drops the note when the location has no provisioned fields", async () => {
      fields.listByLocation.mockResolvedValue([]);
      const outcome = await worker.process(JOB);
      expect(outcome.status).toBe("enriched");
      expect(client.updateContactCustomFields).not.toHaveBeenCalled();
      expect(client.createNote).toHaveBeenCalledTimes(1);
    });
  });

  describe("failure handling", () => {
    it("re-throws a transient GHL error so BullMQ retries, recording failed", async () => {
      client.getContact.mockRejectedValue(new GhlApiError("boom", 503, "GET", "/contacts/ct_1"));

      await expect(worker.process(JOB)).rejects.toBeInstanceOf(GhlApiError);
      expect(events.record).toHaveBeenCalledWith(
        expect.objectContaining({ status: "failed" })
      );
    });

    it("throws UnrecoverableError on a permanent GHL error", async () => {
      client.updateContactCustomFields.mockRejectedValue(
        new GhlApiError("bad request", 400, "PUT", "/contacts/ct_1")
      );

      await expect(worker.process(JOB)).rejects.toBeInstanceOf(UnrecoverableError);
      expect(events.record).toHaveBeenCalledWith(
        expect.objectContaining({ status: "failed" })
      );
    });

    it("records a secret-free detail — never the API key", async () => {
      client.getContact.mockRejectedValue(new GhlApiError("boom", 500));
      await expect(worker.process(JOB)).rejects.toBeTruthy();
      const recorded = events.record.mock.calls.find(([i]) => i.status === "failed");
      expect(recorded?.[0].detail).not.toContain("unit-test-plaintext-key");
    });
  });

  describe("guards", () => {
    it("throws UnrecoverableError when the job has no location", async () => {
      await expect(worker.process({ contact_id: "ct_1" })).rejects.toBeInstanceOf(
        UnrecoverableError
      );
    });
  });
});
