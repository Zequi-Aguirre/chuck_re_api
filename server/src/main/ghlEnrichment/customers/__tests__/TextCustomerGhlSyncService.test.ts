import { randomUUID } from "crypto";
import { AxiosInstance } from "axios";
import { mock, MockProxy } from "jest-mock-extended";
import { GhlApiClient, GhlConnectionUnavailableError } from "../../api/GhlApiClient";
import { GhlCustomField } from "../../api/GhlApiTypes";
import { GhlEnrichmentConfig } from "../../config/GhlEnrichmentConfig";
import { GhlConnectionService } from "../../connections/GhlConnectionService";
import { GhlConnection } from "../../connections/GhlConnectionTypes";
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

  /**
   * End-to-end wiring through a REAL {@link GhlApiClient} (mocked transport) —
   * the actual JAK-163 bug: gateway mode has the Jake sub-account's creds in
   * Doppler ({@link GhlEnrichmentConfig.gateway}), NOT in the JAK-102 store, so
   * the store has no connection for the gateway location. Before the fix the
   * client threw GhlConnectionUnavailableError → "check that it's connected"
   * even though SMS (which reads config.gateway directly) worked fine.
   */
  describe("gateway-mode wiring (JAK-163, real GhlApiClient)", () => {
    const GW_LOC = "jake_gw";
    // Same master key SMS uses; generated at runtime so nothing secret is committed.
    const gwKey = `pit-${randomUUID()}`;
    const GW_BASE = "https://gateway.example.com";

    /** A GhlApiClient whose axios transport we control (no network, instant backoff). */
    class TestGhlApiClient extends GhlApiClient {
      public readonly transport = { request: jest.fn() };
      public builtFor: GhlConnection[] = [];
      protected createHttpClient(conn: GhlConnection): AxiosInstance {
        this.builtFor.push(conn);
        return this.transport as unknown as AxiosInstance;
      }
      protected delay(): Promise<void> {
        return Promise.resolve();
      }
    }

    const gatewayConfig = (over: Partial<{ apiKey: string; baseUrl: string }> = {}): GhlEnrichmentConfig =>
      ({
        gateway: { locationId: GW_LOC, apiKey: gwKey, baseUrl: GW_BASE, ...over },
      } as GhlEnrichmentConfig);

    let connections: MockProxy<GhlConnectionService>;

    beforeEach(() => {
      connections = mock<GhlConnectionService>();
    });

    const wire = (config: GhlEnrichmentConfig, live = true) => {
      const api = new TestGhlApiClient(connections, guardWith(live), config);
      const service = new TextCustomerGhlSyncService(api, config, guardWith(live));
      return { api, service };
    };

    it("findContact REACHES GHL on the gateway creds when the store has no connection", async () => {
      connections.getByLocationId.mockResolvedValue(null); // gateway loc isn't in the store
      const { api, service } = wire(gatewayConfig());
      api.transport.request.mockResolvedValue({ data: { contact: { id: "ct_1", firstName: "Ada" } } });

      const result = await service.findContact("+17865274077");

      // No "check that it's connected" — the lookup reached GHL...
      expect(result.found).toBe(true);
      expect(result.contact?.ghlContactId).toBe("ct_1");
      // ...authed with the gateway master key + base URL (the SMS creds), on the
      // gateway location — never a store connection.
      expect(api.builtFor[0].apiKey).toBe(gwKey);
      expect(api.builtFor[0].baseUrl).toBe(GW_BASE);
      expect(api.builtFor[0].locationId).toBe(GW_LOC);
    });

    it("syncCustomer REACHES GHL on the gateway creds (list fields + upsert) in production", async () => {
      connections.getByLocationId.mockResolvedValue(null);
      const { api, service } = wire(gatewayConfig());
      api.transport.request.mockImplementation(async (cfg: { url: string }) =>
        cfg.url.includes("customFields")
          ? { data: { customFields: [{ id: "f_textjake", name: "text Jake" }] } }
          : { data: { contact: { id: "ct_1" } } }
      );

      const result = await service.syncCustomer(input);

      expect(result.status).toBe("synced");
      expect(result.ghlContactId).toBe("ct_1");
      // Both the read (list fields) and the write (upsert) authed with gateway creds.
      expect(api.builtFor.every((c) => c.apiKey === gwKey)).toBe(true);
      const upsert = api.transport.request.mock.calls.find((c) => c[0].url === "/contacts/upsert");
      expect(upsert).toBeDefined();
    });

    it("an own_number location WITH a store connection still uses the store creds (multi-tenant intact)", async () => {
      const ownKey = `pit-${randomUUID()}`;
      connections.getByLocationId.mockResolvedValue({
        id: "c1",
        locationId: JAKE_LOC,
        name: null,
        apiKey: ownKey,
        baseUrl: "https://own.example.com",
        phoneNumbers: [],
        status: "active",
        textMode: "own_number",
        autoEnrichmentEnabled: false,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      });
      // Gateway is configured for a DIFFERENT location; this own_number tenant
      // must never borrow the gateway key.
      const api = new TestGhlApiClient(connections, guardWith(true), gatewayConfig());
      const service = new TextCustomerGhlSyncService(api, configWith(JAKE_LOC), guardWith(true));
      api.transport.request.mockResolvedValue({ data: { contact: { id: "ct_1" } } });

      await service.findContact("+17865274077");

      expect(api.builtFor[0].apiKey).toBe(ownKey);
      expect(api.builtFor[0].apiKey).not.toBe(gwKey);
    });

    it("gateway apiKey absent → graceful not-connected message, no crash", async () => {
      connections.getByLocationId.mockResolvedValue(null);
      const { service } = wire(gatewayConfig({ apiKey: "" }));

      const result = await service.findContact("+17865274077");

      expect(result.found).toBe(false);
      expect(result.message).toContain("connected");

      const sync = await service.syncCustomer(input);
      expect(sync.status).toBe("not_connected");
    });

    it("preserves the dev no-POST boundary on the gateway location (read-safe, no write)", async () => {
      connections.getByLocationId.mockResolvedValue(null);
      const { api, service } = wire(gatewayConfig(), false); // dev

      const result = await service.syncCustomer(input);

      // Dev skips the whole sync before any HTTP — no read, no write to the gateway.
      expect(result.status).toBe("skipped");
      expect(api.transport.request).not.toHaveBeenCalled();
    });
  });
});
