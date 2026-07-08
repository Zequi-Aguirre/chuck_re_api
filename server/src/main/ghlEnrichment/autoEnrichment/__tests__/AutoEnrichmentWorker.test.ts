/**
 * JAK-183 — AutoEnrichmentWorker pipeline tests.
 *
 * The REAPI DAO + GHL write-back are mocked — NO real outbound. Covers the four
 * required cases + address handling + retry classification:
 *   - happy path: lookup → format → write called with the right args
 *   - not-found terminal: no write, no throw (no infinite retry)
 *   - transient REAPI error: rethrown so BullMQ retries
 *   - permanent REAPI error: UnrecoverableError (no retry)
 *   - address resolution: structured first, rawContact fallback, unresolvable
 */
import { UnrecoverableError } from "bullmq";
import { mock, MockProxy } from "jest-mock-extended";
import { AutoEnrichmentWorker } from "../AutoEnrichmentWorker";
import { RealEstateApiDao } from "../../../data/RealEstateApiDao";
import { EnrichmentFieldWriteBackService } from "../EnrichmentFieldWriteBackService";
import { AutoEnrichmentJobPayload } from "../AutoEnrichmentQueueTypes";
import { RealEstateApiPropertyDetail } from "../../../types/RealEstateApi";

/** A REAPI subject the JAK-184 formatter can map (structurally a PropertyDetail). */
const subject = (): RealEstateApiPropertyDetail =>
  ({
    mlsActive: false,
    propertyType: "SFR",
    estimatedEquity: 275000,
    ownerInfo: { owner1FullName: "Jane Q. Homeowner" },
    propertyInfo: {
      address: { label: "742 Evergreen Terrace, Springfield, IL 62704" },
      bedrooms: 3,
    },
  } as unknown as RealEstateApiPropertyDetail);

const structuredJob = (over: Partial<AutoEnrichmentJobPayload> = {}): AutoEnrichmentJobPayload => ({
  locationId: "loc_1",
  contactId: "contact_1",
  address: { line1: "742 Evergreen Terrace", city: "Springfield", state: "IL", postal: "62704" },
  ...over,
});

/** An axios-like HTTP error carrying a status the worker classifies on. */
const httpError = (status: number) =>
  Object.assign(new Error(`HTTP ${status}`), { response: { status } });

describe("AutoEnrichmentWorker", () => {
  let realEstate: MockProxy<RealEstateApiDao>;
  let writeBack: MockProxy<EnrichmentFieldWriteBackService>;
  let worker: AutoEnrichmentWorker;

  beforeEach(() => {
    realEstate = mock<RealEstateApiDao>();
    writeBack = mock<EnrichmentFieldWriteBackService>();
    writeBack.writeEnrichmentFields.mockResolvedValue({
      written: ["MLS Status", "Property Type", "Owner of Record"],
      skipped: [],
      didWrite: true,
    });
    worker = new AutoEnrichmentWorker(realEstate, writeBack);
    jest.spyOn(console, "log").mockImplementation(() => undefined);
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  describe("happy path", () => {
    it("looks up → formats → writes with the right args", async () => {
      realEstate.getPropertyDetailSubjectByAddress.mockResolvedValue(subject());

      const outcome = await worker.process(structuredJob());

      // Lookup used the normalized single-line address built from the parts.
      expect(realEstate.getPropertyDetailSubjectByAddress).toHaveBeenCalledWith(
        "742 Evergreen Terrace, Springfield, IL 62704"
      );

      // Write-back called with (locationId, contactId, formatterOutput). The
      // formatter maps the subject → logical fields (JAK-184).
      expect(writeBack.writeEnrichmentFields).toHaveBeenCalledTimes(1);
      const [locationId, contactId, fields] = writeBack.writeEnrichmentFields.mock.calls[0];
      expect(locationId).toBe("loc_1");
      expect(contactId).toBe("contact_1");
      expect(fields).toMatchObject({
        mlsStatus: "Off Market",
        propertyType: "SFR",
        estimatedEquity: 275000,
        ownerOfRecord: "Jane Q. Homeowner",
        beds: 3,
        propertyAddress: "742 Evergreen Terrace, Springfield, IL 62704",
      });

      expect(outcome).toEqual({
        status: "enriched",
        locationId: "loc_1",
        contactId: "contact_1",
        written: 3,
        skipped: 0,
      });
    });
  });

  describe("not-found (terminal, no retry)", () => {
    it("finishes cleanly with no write when REAPI has no match", async () => {
      realEstate.getPropertyDetailSubjectByAddress.mockResolvedValue(null);

      const outcome = await worker.process(structuredJob());

      expect(outcome).toEqual({ status: "not_found", locationId: "loc_1", contactId: "contact_1" });
      expect(writeBack.writeEnrichmentFields).not.toHaveBeenCalled();
    });
  });

  describe("transient error (retry)", () => {
    it.each([429, 500, 503])("rethrows on HTTP %d so BullMQ retries", async (status) => {
      realEstate.getPropertyDetailSubjectByAddress.mockRejectedValue(httpError(status));
      await expect(worker.process(structuredJob())).rejects.toThrow(`HTTP ${status}`);
      expect(writeBack.writeEnrichmentFields).not.toHaveBeenCalled();
    });

    it("rethrows a network error with no HTTP status (transient)", async () => {
      const netErr = Object.assign(new Error("ECONNRESET"), { code: "ECONNRESET" });
      realEstate.getPropertyDetailSubjectByAddress.mockRejectedValue(netErr);
      await expect(worker.process(structuredJob())).rejects.toThrow("ECONNRESET");
    });

    it("does NOT wrap a transient error as UnrecoverableError", async () => {
      realEstate.getPropertyDetailSubjectByAddress.mockRejectedValue(httpError(502));
      await expect(worker.process(structuredJob())).rejects.not.toBeInstanceOf(
        UnrecoverableError
      );
    });
  });

  describe("permanent error (no retry)", () => {
    it.each([400, 401, 403])(
      "wraps HTTP %d as UnrecoverableError so BullMQ won't retry",
      async (status) => {
        realEstate.getPropertyDetailSubjectByAddress.mockRejectedValue(httpError(status));
        await expect(worker.process(structuredJob())).rejects.toBeInstanceOf(UnrecoverableError);
        expect(writeBack.writeEnrichmentFields).not.toHaveBeenCalled();
      }
    );
  });

  describe("address resolution", () => {
    it("falls back to rawContact when the job has no structured address", async () => {
      realEstate.getPropertyDetailSubjectByAddress.mockResolvedValue(subject());
      const job: AutoEnrichmentJobPayload = {
        locationId: "loc_1",
        contactId: "contact_2",
        rawContact: {
          address1: "500 Main St",
          city: "Dallas",
          state: "TX",
          postalCode: "75001",
          firstName: "Jane",
        },
      };

      const outcome = await worker.process(job);

      expect(realEstate.getPropertyDetailSubjectByAddress).toHaveBeenCalledWith(
        "500 Main St, Dallas, TX 75001"
      );
      expect(outcome.status).toBe("enriched");
    });

    it("returns no_address (no lookup/write) when nothing resolvable is present", async () => {
      const job: AutoEnrichmentJobPayload = {
        locationId: "loc_1",
        contactId: "contact_3",
        rawContact: { firstName: "Jane", lastName: "Doe" },
      };

      const outcome = await worker.process(job);

      expect(outcome).toEqual({ status: "no_address", locationId: "loc_1", contactId: "contact_3" });
      expect(realEstate.getPropertyDetailSubjectByAddress).not.toHaveBeenCalled();
      expect(writeBack.writeEnrichmentFields).not.toHaveBeenCalled();
    });

    it("returns no_address when a structured address has no street line", async () => {
      const outcome = await worker.process(
        structuredJob({ address: { city: "Springfield", state: "IL", postal: "62704" } })
      );
      expect(outcome.status).toBe("no_address");
      expect(realEstate.getPropertyDetailSubjectByAddress).not.toHaveBeenCalled();
    });
  });

  describe("overwrite semantics", () => {
    it("re-processing the same contact just calls the (overwriting) write-back again", async () => {
      realEstate.getPropertyDetailSubjectByAddress.mockResolvedValue(subject());
      await worker.process(structuredJob());
      await worker.process(structuredJob());
      expect(writeBack.writeEnrichmentFields).toHaveBeenCalledTimes(2);
      // Same (locationId, contactId) both times — JAK-185 overwrites by field id.
      expect(writeBack.writeEnrichmentFields.mock.calls[0][1]).toBe("contact_1");
      expect(writeBack.writeEnrichmentFields.mock.calls[1][1]).toBe("contact_1");
    });
  });
});
