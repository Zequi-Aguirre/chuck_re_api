import { mock, MockProxy } from "jest-mock-extended";
import { GhlApiClient, GhlConnectionUnavailableError } from "../../api/GhlApiClient";
import { GhlCustomField } from "../../api/GhlApiTypes";
import { GhlEnrichmentConfig } from "../../config/GhlEnrichmentConfig";
import { ExternalActionGuard } from "../../../safety/ExternalActionGuard";
import { TextCustomerGhlSyncService } from "../TextCustomerGhlSyncService";

const JAKE_LOC = "jake_loc";

/** Config whose ONLY relevant surface is the Jake gateway location id (JAK-147). */
const configWith = (locationId: string): GhlEnrichmentConfig =>
  ({ gateway: { locationId, apiKey: "unit-test-key", baseUrl: "https://x.test" } } as GhlEnrichmentConfig);

/** The single write-safety boundary — live on prod/staging, off in dev (JAK-110). */
const guardWith = (live: boolean): ExternalActionGuard =>
  ({ liveActionsAllowed: live, echoSkipped: jest.fn() } as unknown as ExternalActionGuard);

const field = (over: Partial<GhlCustomField> = {}): GhlCustomField => ({
  id: "f_other",
  name: "Some Field",
  ...over,
});

const input = {
  phone: "+17865274077",
  firstName: "Ada",
  lastName: "Lovelace",
  email: "ada@example.com",
};

describe("TextCustomerGhlSyncService", () => {
  let client: MockProxy<GhlApiClient>;

  beforeEach(() => {
    client = mock<GhlApiClient>();
  });

  const build = (live: boolean, locationId = JAKE_LOC) =>
    new TextCustomerGhlSyncService(client, configWith(locationId), guardWith(live));

  describe("syncCustomer", () => {
    it("finds the 'text Jake' field, upserts the contact by phone, and sets it approved", async () => {
      client.listCustomFields.mockResolvedValue([
        field(),
        field({ id: "f_textjake", name: "text Jake" }),
      ]);
      client.upsertContact.mockResolvedValue({ id: "ct_1" } as never);

      const result = await build(true).syncCustomer(input);

      expect(client.listCustomFields).toHaveBeenCalledWith(JAKE_LOC);
      // Name + email are written, and the approval field is set to `true`.
      expect(client.upsertContact).toHaveBeenCalledWith(JAKE_LOC, {
        phone: "+17865274077",
        firstName: "Ada",
        lastName: "Lovelace",
        email: "ada@example.com",
        customFields: [{ id: "f_textjake", value: true }],
      });
      expect(result.status).toBe("synced");
      expect(result.ghlContactId).toBe("ct_1");
    });

    it.each([
      ["exact name", { name: "text Jake" }],
      ["different case", { name: "Text Jake" }],
      ["prefixed field key", { name: "unrelated", fieldKey: "contact.text_jake" }],
      ["camel field key", { name: "unrelated", fieldKey: "textJake" }],
    ])("matches the approval field by %s (case-insensitive)", async (_label, over) => {
      client.listCustomFields.mockResolvedValue([field({ id: "f_textjake", ...over })]);
      client.upsertContact.mockResolvedValue({ id: "ct_1" } as never);

      const result = await build(true).syncCustomer(input);

      expect(result.status).toBe("synced");
      expect(client.upsertContact.mock.calls[0][1].customFields).toEqual([
        { id: "f_textjake", value: true },
      ]);
    });

    it("surfaces a clear error and does NOT upsert when 'text Jake' isn't found", async () => {
      client.listCustomFields.mockResolvedValue([field(), field({ name: "Another" })]);

      const result = await build(true).syncCustomer(input);

      expect(result.status).toBe("field_not_found");
      expect(result.message).toContain("text Jake");
      expect(client.upsertContact).not.toHaveBeenCalled();
    });

    it("in DEV, skips the sync entirely — no read, no write to GHL (JAK-110)", async () => {
      const guard = guardWith(false);
      const service = new TextCustomerGhlSyncService(client, configWith(JAKE_LOC), guard);

      const result = await service.syncCustomer(input);

      expect(result.status).toBe("skipped");
      expect(client.listCustomFields).not.toHaveBeenCalled();
      expect(client.upsertContact).not.toHaveBeenCalled();
      expect(guard.echoSkipped).toHaveBeenCalled();
    });

    it("reports not-connected (no calls) when the Jake sub-account isn't configured", async () => {
      const result = await build(true, "").syncCustomer(input);

      expect(result.status).toBe("not_connected");
      expect(client.listCustomFields).not.toHaveBeenCalled();
      expect(client.upsertContact).not.toHaveBeenCalled();
    });

    it("reports not-connected when the Jake sub-account has no connection on file", async () => {
      client.listCustomFields.mockRejectedValue(
        new GhlConnectionUnavailableError(JAKE_LOC, "no connection on file")
      );

      const result = await build(true).syncCustomer(input);

      expect(result.status).toBe("not_connected");
      expect(client.upsertContact).not.toHaveBeenCalled();
    });

    it("is idempotent: re-saving the same customer upserts the SAME phone (no duplicate)", async () => {
      client.listCustomFields.mockResolvedValue([field({ id: "f_textjake", name: "text Jake" })]);
      client.upsertContact.mockResolvedValue({ id: "ct_1" } as never);
      const service = build(true);

      const first = await service.syncCustomer(input);
      const second = await service.syncCustomer(input);

      // Both writes target the same phone → GHL updates one contact, not two.
      expect(client.upsertContact).toHaveBeenCalledTimes(2);
      expect(client.upsertContact.mock.calls[0][1].phone).toBe("+17865274077");
      expect(client.upsertContact.mock.calls[1][1].phone).toBe("+17865274077");
      expect(first.ghlContactId).toBe("ct_1");
      expect(second.ghlContactId).toBe("ct_1");
      // The field id is resolved once and cached per location.
      expect(client.listCustomFields).toHaveBeenCalledTimes(1);
    });

    it("returns a friendly error (customer still saved) on an unexpected GHL failure", async () => {
      client.listCustomFields.mockResolvedValue([field({ id: "f_textjake", name: "text Jake" })]);
      client.upsertContact.mockRejectedValue(new Error("boom"));

      const result = await build(true).syncCustomer(input);

      expect(result.status).toBe("error");
      expect(result.ghlContactId).toBeNull();
    });
  });

  describe("setApproval (JAK-148 two-level hold)", () => {
    it("deactivate flips 'text Jake' to an EMPTY (unapproved) value via upsert", async () => {
      client.listCustomFields.mockResolvedValue([field({ id: "f_textjake", name: "text Jake" })]);
      client.upsertContact.mockResolvedValue({ id: "ct_1" } as never);

      const result = await build(true).setApproval(input, false);

      // The approval field is cleared so GHL stops forwarding — value is empty,
      // never the truthy approved value.
      expect(client.upsertContact).toHaveBeenCalledWith(JAKE_LOC, {
        phone: "+17865274077",
        firstName: "Ada",
        lastName: "Lovelace",
        email: "ada@example.com",
        customFields: [{ id: "f_textjake", value: "" }],
      });
      expect(result.status).toBe("synced");
      expect(result.ghlContactId).toBe("ct_1");
    });

    it("reactivate re-approves 'text Jake' (truthy value) via upsert", async () => {
      client.listCustomFields.mockResolvedValue([field({ id: "f_textjake", name: "text Jake" })]);
      client.upsertContact.mockResolvedValue({ id: "ct_1" } as never);

      await build(true).setApproval(input, true);

      expect(client.upsertContact.mock.calls[0][1].customFields).toEqual([
        { id: "f_textjake", value: true },
      ]);
    });

    it("in DEV, skips the field flip entirely — no read, no write to GHL (JAK-110)", async () => {
      const guard = guardWith(false);
      const service = new TextCustomerGhlSyncService(client, configWith(JAKE_LOC), guard);

      const result = await service.setApproval(input, false);

      expect(result.status).toBe("skipped");
      expect(client.listCustomFields).not.toHaveBeenCalled();
      expect(client.upsertContact).not.toHaveBeenCalled();
      expect(guard.echoSkipped).toHaveBeenCalled();
    });
  });

  describe("findContact", () => {
    it("returns an existing contact for prefill (find-existing-contact-by-phone)", async () => {
      client.findContactByPhone.mockResolvedValue({
        id: "ct_1",
        firstName: "Ada",
        lastName: "Lovelace",
        email: "ada@example.com",
      } as never);

      const result = await build(true).findContact("+17865274077");

      expect(client.findContactByPhone).toHaveBeenCalledWith(JAKE_LOC, "+17865274077");
      expect(result.found).toBe(true);
      expect(result.contact).toEqual({
        ghlContactId: "ct_1",
        firstName: "Ada",
        lastName: "Lovelace",
        email: "ada@example.com",
      });
    });

    it("returns a friendly not-found when no contact exists yet", async () => {
      client.findContactByPhone.mockResolvedValue(null);

      const result = await build(true).findContact("+15550001111");

      expect(result.found).toBe(false);
      expect(result.contact).toBeNull();
    });

    it("returns a reachability message when the Jake sub-account isn't connected", async () => {
      client.findContactByPhone.mockRejectedValue(
        new GhlConnectionUnavailableError(JAKE_LOC, "no connection on file")
      );

      const result = await build(true).findContact("+17865274077");

      expect(result.found).toBe(false);
      expect(result.contact).toBeNull();
    });

    it("returns not-found (no call) when the Jake sub-account isn't configured", async () => {
      const result = await build(true, "").findContact("+17865274077");

      expect(result.found).toBe(false);
      expect(client.findContactByPhone).not.toHaveBeenCalled();
    });
  });
});
