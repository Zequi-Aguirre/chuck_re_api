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
import { AddressLlmParser } from "../AddressLlmParser";
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
  let addressLlm: MockProxy<AddressLlmParser>;
  let worker: AutoEnrichmentWorker;

  beforeEach(() => {
    realEstate = mock<RealEstateApiDao>();
    writeBack = mock<EnrichmentFieldWriteBackService>();
    writeBack.writeEnrichmentFields.mockResolvedValue({
      written: ["MLS Status", "Property Type", "Owner on record"],
      skipped: [],
      didWrite: true,
    });
    addressLlm = mock<AddressLlmParser>();
    addressLlm.parse.mockResolvedValue(null); // off by default; overridden per test.
    worker = new AutoEnrichmentWorker(realEstate, writeBack, addressLlm);
    jest.spyOn(console, "log").mockImplementation(() => undefined);
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  describe("happy path", () => {
    it("looks up → formats → writes with the right args", async () => {
      realEstate.getPropertyDetailSubjectByParts.mockResolvedValue(subject());

      const outcome = await worker.process(structuredJob());

      // Lookup used the CLEAN, STRUCTURED parts built from the payload — no reparse.
      expect(realEstate.getPropertyDetailSubjectByParts).toHaveBeenCalledWith({
        house: "742",
        street: "Evergreen Terrace",
        city: "Springfield",
        state: "IL",
        zip: "62704",
      });

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
      realEstate.getPropertyDetailSubjectByParts.mockResolvedValue(null);

      const outcome = await worker.process(structuredJob());

      expect(outcome).toEqual({ status: "not_found", locationId: "loc_1", contactId: "contact_1" });
      expect(writeBack.writeEnrichmentFields).not.toHaveBeenCalled();
    });
  });

  describe("transient error (retry)", () => {
    it.each([429, 500, 503])("rethrows on HTTP %d so BullMQ retries", async (status) => {
      realEstate.getPropertyDetailSubjectByParts.mockRejectedValue(httpError(status));
      await expect(worker.process(structuredJob())).rejects.toThrow(`HTTP ${status}`);
      expect(writeBack.writeEnrichmentFields).not.toHaveBeenCalled();
    });

    it("rethrows a network error with no HTTP status (transient)", async () => {
      const netErr = Object.assign(new Error("ECONNRESET"), { code: "ECONNRESET" });
      realEstate.getPropertyDetailSubjectByParts.mockRejectedValue(netErr);
      await expect(worker.process(structuredJob())).rejects.toThrow("ECONNRESET");
    });

    it("does NOT wrap a transient error as UnrecoverableError", async () => {
      realEstate.getPropertyDetailSubjectByParts.mockRejectedValue(httpError(502));
      await expect(worker.process(structuredJob())).rejects.not.toBeInstanceOf(
        UnrecoverableError
      );
    });
  });

  describe("permanent error (no retry)", () => {
    it.each([400, 401, 403])(
      "wraps HTTP %d as UnrecoverableError so BullMQ won't retry",
      async (status) => {
        realEstate.getPropertyDetailSubjectByParts.mockRejectedValue(httpError(status));
        await expect(worker.process(structuredJob())).rejects.toBeInstanceOf(UnrecoverableError);
        expect(writeBack.writeEnrichmentFields).not.toHaveBeenCalled();
      }
    );
  });

  describe("address resolution", () => {
    it("falls back to rawContact when the job has no structured address", async () => {
      realEstate.getPropertyDetailSubjectByParts.mockResolvedValue(subject());
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

      expect(realEstate.getPropertyDetailSubjectByParts).toHaveBeenCalledWith({
        house: "500",
        street: "Main St",
        city: "Dallas",
        state: "TX",
        zip: "75001",
      });
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
      expect(realEstate.getPropertyDetailSubjectByParts).not.toHaveBeenCalled();
      expect(writeBack.writeEnrichmentFields).not.toHaveBeenCalled();
    });

    it("returns no_address when a structured address has no street line", async () => {
      const outcome = await worker.process(
        structuredJob({ address: { city: "Springfield", state: "IL", postal: "62704" } })
      );
      expect(outcome.status).toBe("no_address");
      expect(realEstate.getPropertyDetailSubjectByParts).not.toHaveBeenCalled();
    });
  });

  // JAK-193 — the two live production failures. Both used to die at parseAddress
  // (returning null → "no match" logged) BEFORE any REAPI call. Now the worker
  // builds clean structured parts and REAPI is actually queried.
  describe("dirty GHL fields (JAK-193)", () => {
    it("strips a 'z:' label off the zip so REAPI gets the bare 5-digit", async () => {
      realEstate.getPropertyDetailSubjectByParts.mockResolvedValue(subject());

      await worker.process(
        structuredJob({
          address: { line1: "14001 N 127th Ln", city: "El Mirage", state: "AZ", postal: "z:85335" },
        })
      );

      expect(realEstate.getPropertyDetailSubjectByParts).toHaveBeenCalledWith({
        house: "14001",
        street: "N 127th Ln",
        city: "El Mirage",
        state: "AZ",
        zip: "85335",
      });
    });

    it("derives the state from the zip when GHL omits it", async () => {
      realEstate.getPropertyDetailSubjectByParts.mockResolvedValue(subject());

      await worker.process(
        structuredJob({
          contactId: "contact_atoka",
          address: { line1: "3165 Tracy Rd", city: "atoka", postal: "38004" },
        })
      );

      // 38004 → ZIP3 380 → TN, so REAPI is queried WITH a state (Case 2 resolves).
      expect(realEstate.getPropertyDetailSubjectByParts).toHaveBeenCalledWith({
        house: "3165",
        street: "Tracy Rd",
        city: "atoka",
        state: "TN",
        zip: "38004",
      });
    });
  });

  // JAK-195 — GHL sometimes crams the WHOLE address into address1 with the
  // structured city/state/zip fields empty. Those must still enrich (Eric).
  describe("full address in the street field (JAK-195)", () => {
    it("parses a full address in the structured line1 (city/state/zip empty)", async () => {
      realEstate.getPropertyDetailSubjectByParts.mockResolvedValue(subject());

      const outcome = await worker.process(
        structuredJob({ address: { line1: "14001 N 127th Ln, El Mirage, AZ 85335" } })
      );

      expect(realEstate.getPropertyDetailSubjectByParts).toHaveBeenCalledWith({
        house: "14001",
        street: "N 127th Ln",
        city: "El Mirage",
        state: "AZ",
        zip: "85335",
      });
      expect(outcome.status).toBe("enriched");
    });

    it("parses a full address in rawContact.address1 (city/state/zip empty)", async () => {
      realEstate.getPropertyDetailSubjectByParts.mockResolvedValue(subject());
      const job: AutoEnrichmentJobPayload = {
        locationId: "loc_1",
        contactId: "contact_raw_full",
        rawContact: { address1: "3165 Tracy Rd, atoka, 38004", firstName: "Jane" },
      };

      const outcome = await worker.process(job);

      // state derived from the embedded zip (38004 → TN).
      expect(realEstate.getPropertyDetailSubjectByParts).toHaveBeenCalledWith({
        house: "3165",
        street: "Tracy Rd",
        city: "atoka",
        state: "TN",
        zip: "38004",
      });
      expect(outcome.status).toBe("enriched");
    });

    it("still no_address for a bare street with no zip anywhere (no regression)", async () => {
      const outcome = await worker.process(
        structuredJob({ address: { line1: "742 Evergreen Terrace" } })
      );
      expect(outcome.status).toBe("no_address");
      expect(realEstate.getPropertyDetailSubjectByParts).not.toHaveBeenCalled();
    });
  });

  // JAK-196 — GHL crams the WHOLE address into the street field, sometimes WITH
  // the structured city/state/zip ALSO filled. Before, splitStreet swallowed the
  // comma-laden line1 as `street`, so REAPI saw "Pearson Oaks Dr, collierville, TN,
  // 38017" and never matched. Now the street is de-polluted deterministically; the
  // no-comma blob (nothing to anchor on) falls back to the LLM parser.
  describe("dirty full-address-in-line1 (JAK-196)", () => {
    const CLEAN = {
      house: "828",
      street: "Pearson Oaks Dr",
      city: "collierville",
      state: "TN",
      zip: "38017",
    };

    it("CASE 1: full address in line1 AND structured city/state/zip also filled → clean street, no LLM", async () => {
      realEstate.getPropertyDetailSubjectByParts.mockResolvedValue(subject());

      const outcome = await worker.process(
        structuredJob({
          address: {
            line1: "828 Pearson Oaks Dr, collierville, TN, 38017",
            city: "collierville",
            state: "TN",
            postal: "38017",
          },
        })
      );

      // REAPI receives the CLEAN street, not the polluted comma string.
      expect(realEstate.getPropertyDetailSubjectByParts).toHaveBeenCalledWith(CLEAN);
      expect(outcome.status).toBe("enriched");
      expect(addressLlm.parse).not.toHaveBeenCalled(); // deterministic handled it.
    });

    it("no-comma blob WITH structured city/state/zip → stripped clean, no LLM", async () => {
      realEstate.getPropertyDetailSubjectByParts.mockResolvedValue(subject());

      const outcome = await worker.process(
        structuredJob({
          address: {
            line1: "828 Pearson Oaks Dr collierville TN 38017",
            city: "collierville",
            state: "TN",
            postal: "38017",
          },
        })
      );

      expect(realEstate.getPropertyDetailSubjectByParts).toHaveBeenCalledWith(CLEAN);
      expect(outcome.status).toBe("enriched");
      expect(addressLlm.parse).not.toHaveBeenCalled();
    });

    it("CASE 2 (no-comma blob, structured EMPTY) → deterministic fails → LLM parses → enriched", async () => {
      realEstate.getPropertyDetailSubjectByParts.mockResolvedValue(subject());
      addressLlm.parse.mockResolvedValue(CLEAN); // the model splits the blob.

      const outcome = await worker.process(
        structuredJob({ address: { line1: "828 Pearson Oaks Dr collierville TN 38017" } })
      );

      // LLM was consulted with the raw blob; hints carried the (empty) structured fields.
      expect(addressLlm.parse).toHaveBeenCalledTimes(1);
      expect(addressLlm.parse.mock.calls[0][0]).toBe("828 Pearson Oaks Dr collierville TN 38017");
      expect(realEstate.getPropertyDetailSubjectByParts).toHaveBeenCalledWith(CLEAN);
      expect(outcome.status).toBe("enriched");
    });

    it("no-comma blob, structured EMPTY, LLM unavailable (null) → no_address", async () => {
      addressLlm.parse.mockResolvedValue(null); // no key / parse failure.

      const outcome = await worker.process(
        structuredJob({ address: { line1: "828 Pearson Oaks Dr collierville TN 38017" } })
      );

      expect(outcome.status).toBe("no_address");
      expect(realEstate.getPropertyDetailSubjectByParts).not.toHaveBeenCalled();
    });

    it("does NOT invoke the LLM when the deterministic parse already succeeds (comma case)", async () => {
      realEstate.getPropertyDetailSubjectByParts.mockResolvedValue(subject());

      await worker.process(
        structuredJob({ address: { line1: "828 Pearson Oaks Dr, collierville, TN, 38017" } })
      );

      expect(addressLlm.parse).not.toHaveBeenCalled();
    });
  });

  describe("overwrite semantics", () => {
    it("re-processing the same contact just calls the (overwriting) write-back again", async () => {
      realEstate.getPropertyDetailSubjectByParts.mockResolvedValue(subject());
      await worker.process(structuredJob());
      await worker.process(structuredJob());
      expect(writeBack.writeEnrichmentFields).toHaveBeenCalledTimes(2);
      // Same (locationId, contactId) both times — JAK-185 overwrites by field id.
      expect(writeBack.writeEnrichmentFields.mock.calls[0][1]).toBe("contact_1");
      expect(writeBack.writeEnrichmentFields.mock.calls[1][1]).toBe("contact_1");
    });
  });
});
