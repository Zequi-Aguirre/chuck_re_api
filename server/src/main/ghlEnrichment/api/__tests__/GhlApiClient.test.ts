import { randomUUID } from "crypto";
import { AxiosInstance } from "axios";
import { mock, MockProxy } from "jest-mock-extended";
import {
  GhlApiClient,
  GhlApiError,
  GhlConnectionUnavailableError,
} from "../GhlApiClient";
import { GhlConnectionService } from "../../connections/GhlConnectionService";
import { GhlConnection } from "../../connections/GhlConnectionTypes";
import { GhlEnrichmentConfig } from "../../config/GhlEnrichmentConfig";
import { ExternalActionGuard } from "../../../safety/ExternalActionGuard";

/** A fake axios transport whose `request` we control per test. */
type FakeTransport = { request: jest.Mock };

/**
 * Test double: replaces the real axios instance with a controllable transport
 * and makes backoff delays instant (recording the requested waits so we can
 * assert the backoff/retry-after logic).
 */
class TestGhlApiClient extends GhlApiClient {
  public readonly transport: FakeTransport = { request: jest.fn() };
  public builtFor: GhlConnection[] = [];
  public delays: number[] = [];

  protected createHttpClient(conn: GhlConnection): AxiosInstance {
    this.builtFor.push(conn);
    return this.transport as unknown as AxiosInstance;
  }

  protected delay(ms: number): Promise<void> {
    this.delays.push(ms);
    return Promise.resolve();
  }
}

/** Build an axios-shaped error so `axios.isAxiosError` recognizes it. */
const axiosError = (
  status?: number,
  headers: Record<string, string> = {}
): Error =>
  Object.assign(new Error(`HTTP ${status ?? "network"}`), {
    isAxiosError: true,
    code: status ? undefined : "ECONNRESET",
    response: status ? { status, headers, data: {} } : undefined,
  });

const conn = (over: Partial<GhlConnection> = {}): GhlConnection => ({
  id: "11111111-1111-1111-1111-111111111111",
  locationId: "loc_1",
  // Shape-matches a GHL Private Integration Token but is generated at runtime,
  // so nothing secret-looking is ever committed.
  apiKey: `pit-${randomUUID()}`,
  baseUrl: "https://services.leadconnectorhq.com",
  phoneNumbers: [],
  status: "active",
  createdAt: new Date("2026-07-01T00:00:00Z"),
  updatedAt: new Date("2026-07-01T00:00:00Z"),
  ...over,
});

/**
 * A fake dev-safety guard whose `liveActionsAllowed` we fix per test. This is
 * the single boundary the client gates writes on (JAK-110); the echo sink is a
 * no-op here so tests stay quiet.
 */
const guardWith = (live: boolean): ExternalActionGuard =>
  ({ liveActionsAllowed: live, echoSkipped: () => {} } as unknown as ExternalActionGuard);

// prod + staging both permit writes; dev never does.
const prodGuard = guardWith(true);
const stagingGuard = guardWith(true);
const devGuard = guardWith(false);

/**
 * A config exposing only the gateway surface the client reads (JAK-163). The
 * default is an UNCONFIGURED gateway so existing per-location tests exercise the
 * pure store path — the fallback never triggers for a non-gateway location.
 */
const configWith = (
  gateway: Partial<{ apiKey: string; locationId: string; baseUrl: string }> = {}
): GhlEnrichmentConfig =>
  ({
    gateway: { apiKey: "", locationId: "", baseUrl: "", ...gateway },
  } as unknown as GhlEnrichmentConfig);

/** No gateway configured — the JAK-163 fallback stays dormant. */
const noGateway = configWith();

describe("GhlApiClient", () => {
  let connections: MockProxy<GhlConnectionService>;

  beforeEach(() => {
    connections = mock<GhlConnectionService>();
  });

  const ok = (data: unknown) => ({ data });

  describe("per-location credential resolution (multi-tenant)", () => {
    it("builds the client from the connection store's decrypted key + base_url", async () => {
      const c = conn({ apiKey: `pit-${randomUUID()}`, baseUrl: "https://tenant-a.example.com" });
      connections.getByLocationId.mockResolvedValue(c);
      const client = new TestGhlApiClient(connections, prodGuard, noGateway);
      client.transport.request.mockResolvedValue(ok({ contact: { id: "ct_1" } }));

      await client.getContact("loc_1", "ct_1");

      expect(connections.getByLocationId).toHaveBeenCalledWith("loc_1");
      expect(client.builtFor).toHaveLength(1);
      expect(client.builtFor[0].apiKey).toBe(c.apiKey);
      expect(client.builtFor[0].baseUrl).toBe("https://tenant-a.example.com");
    });

    it("uses a distinct client per location (isolation between tenants)", async () => {
      const a = conn({ locationId: "loc_a", baseUrl: "https://a.example.com" });
      const b = conn({ locationId: "loc_b", baseUrl: "https://b.example.com" });
      connections.getByLocationId.mockImplementation(async (loc) =>
        loc === "loc_a" ? a : b
      );
      const client = new TestGhlApiClient(connections, prodGuard, noGateway);
      client.transport.request.mockResolvedValue(ok({ contact: { id: "x" } }));

      await client.getContact("loc_a", "ct");
      await client.getContact("loc_b", "ct");

      expect(client.builtFor.map((c) => c.baseUrl)).toEqual([
        "https://a.example.com",
        "https://b.example.com",
      ]);
    });

    it("caches the client per location (builds once across calls)", async () => {
      connections.getByLocationId.mockResolvedValue(conn());
      const client = new TestGhlApiClient(connections, prodGuard, noGateway);
      client.transport.request.mockResolvedValue(ok({ customFields: [] }));

      await client.listCustomFields("loc_1");
      await client.listCustomFields("loc_1");

      expect(client.builtFor).toHaveLength(1);
      expect(connections.getByLocationId).toHaveBeenCalledTimes(1);
    });

    it("sets a Bearer header and base URL from the connection (real builder)", () => {
      const client = new GhlApiClient(connections, prodGuard, noGateway);
      const c = conn({ baseUrl: "https://tenant.example.com" });
      // Exercise the real createHttpClient (protected) to prove auth wiring.
      const http = (client as unknown as {
        createHttpClient(x: GhlConnection): AxiosInstance;
      }).createHttpClient(c);
      expect(http.defaults.baseURL).toBe("https://tenant.example.com");
      expect(String(http.defaults.headers.Authorization)).toBe(`Bearer ${c.apiKey}`);
    });

    it("throws GhlConnectionUnavailableError when the location is unknown", async () => {
      connections.getByLocationId.mockResolvedValue(null);
      const client = new TestGhlApiClient(connections, prodGuard, noGateway);
      await expect(client.getContact("missing", "ct")).rejects.toBeInstanceOf(
        GhlConnectionUnavailableError
      );
    });

    it("refuses to use an inactive (uninstalled) connection", async () => {
      connections.getByLocationId.mockResolvedValue(conn({ status: "inactive" }));
      const client = new TestGhlApiClient(connections, prodGuard, noGateway);
      await expect(client.getContact("loc_1", "ct")).rejects.toBeInstanceOf(
        GhlConnectionUnavailableError
      );
    });
  });

  describe("gateway-location credential fallback (JAK-163)", () => {
    const GW_LOC = "jake_gw";
    // Shape-matches a GHL master token but generated at runtime — nothing secret
    // is ever committed. This is the SAME key the SMS gateway uses.
    const gwKey = `pit-${randomUUID()}`;
    const GW_BASE = "https://gateway.example.com";
    const gatewayConfig = configWith({
      apiKey: gwKey,
      locationId: GW_LOC,
      baseUrl: GW_BASE,
    });

    it("READS reach GHL on the gateway Doppler creds when the store has no connection", async () => {
      // Gateway mode: creds live in Doppler, never pasted into the JAK-102 store.
      connections.getByLocationId.mockResolvedValue(null);
      const client = new TestGhlApiClient(connections, prodGuard, gatewayConfig);
      client.transport.request.mockResolvedValue(ok({ contact: { id: "ct_1" } }));

      const contact = await client.findContactByPhone(GW_LOC, "+17865274077");

      // No GhlConnectionUnavailableError — the call reached GHL...
      expect(contact?.id).toBe("ct_1");
      // ...authed with the gateway master key + base URL (the SMS key), not a
      // store connection.
      expect(client.builtFor).toHaveLength(1);
      expect(client.builtFor[0].apiKey).toBe(gwKey);
      expect(client.builtFor[0].baseUrl).toBe(GW_BASE);
      expect(client.builtFor[0].locationId).toBe(GW_LOC);
    });

    it("WRITES (upsert/sync-on-save) reach GHL on the gateway creds in production", async () => {
      connections.getByLocationId.mockResolvedValue(null);
      const client = new TestGhlApiClient(connections, prodGuard, gatewayConfig);
      client.transport.request.mockResolvedValue(ok({ contact: { id: "ct_1" } }));

      const contact = await client.upsertContact(GW_LOC, {
        phone: "+17865274077",
        firstName: "Ada",
        lastName: null,
        email: null,
        customFields: [{ id: "f_textjake", value: true }],
      });

      expect(contact?.id).toBe("ct_1");
      expect(client.builtFor[0].apiKey).toBe(gwKey);
      expect(client.transport.request.mock.calls[0][0].url).toBe("/contacts/upsert");
    });

    it("lists custom fields on the gateway location via the gateway creds", async () => {
      connections.getByLocationId.mockResolvedValue(null);
      const client = new TestGhlApiClient(connections, prodGuard, gatewayConfig);
      client.transport.request.mockResolvedValue(ok({ customFields: [{ id: "cf" }] }));

      expect(await client.listCustomFields(GW_LOC)).toHaveLength(1);
      expect(client.builtFor[0].apiKey).toBe(gwKey);
    });

    it("a REAL store connection for the gateway location WINS over the Doppler creds", async () => {
      // If the gateway location ever has its own pasted connection, that per-
      // location key must be used — the Doppler creds are only a fallback.
      const stored = conn({
        locationId: GW_LOC,
        apiKey: `pit-${randomUUID()}`,
        baseUrl: "https://own.example.com",
      });
      connections.getByLocationId.mockResolvedValue(stored);
      const client = new TestGhlApiClient(connections, prodGuard, gatewayConfig);
      client.transport.request.mockResolvedValue(ok({ contact: { id: "ct_1" } }));

      await client.findContactByPhone(GW_LOC, "+17865274077");

      expect(client.builtFor[0].apiKey).toBe(stored.apiKey);
      expect(client.builtFor[0].baseUrl).toBe("https://own.example.com");
      expect(client.builtFor[0].apiKey).not.toBe(gwKey);
    });

    it("does NOT fall back for a non-gateway location (own_number path unaffected)", async () => {
      // An own_number tenant with no store connection must still fail cleanly —
      // the fallback is gateway-location-only, never a blanket master key.
      connections.getByLocationId.mockResolvedValue(null);
      const client = new TestGhlApiClient(connections, prodGuard, gatewayConfig);

      await expect(client.findContactByPhone("some_other_loc", "+1")).rejects.toBeInstanceOf(
        GhlConnectionUnavailableError
      );
      expect(client.builtFor).toHaveLength(0);
    });

    it("stays graceful (not-connected error, no crash) when the gateway apiKey is unset", async () => {
      // Gateway location configured but the master key truly isn't set up.
      const halfConfigured = configWith({ locationId: GW_LOC, baseUrl: GW_BASE, apiKey: "" });
      connections.getByLocationId.mockResolvedValue(null);
      const client = new TestGhlApiClient(connections, prodGuard, halfConfigured);

      await expect(client.findContactByPhone(GW_LOC, "+1")).rejects.toBeInstanceOf(
        GhlConnectionUnavailableError
      );
      // No transport built — nothing crashes trying to auth with an empty key.
      expect(client.builtFor).toHaveLength(0);
    });

    it("still READS on the gateway location in DEV (reads pass through)", async () => {
      // find-contact must work locally too — it's a read, so the write gate
      // never blocks it, and the gateway creds resolve it.
      connections.getByLocationId.mockResolvedValue(null);
      const client = new TestGhlApiClient(connections, devGuard, gatewayConfig);
      client.transport.request.mockResolvedValue(ok({ contact: { id: "ct_1" } }));

      const contact = await client.findContactByPhone(GW_LOC, "+17865274077");

      expect(contact?.id).toBe("ct_1");
      expect(client.builtFor[0].apiKey).toBe(gwKey);
    });

    it("SKIPS gateway-location writes in DEV — no POST, no creds resolved (JAK-110 intact)", async () => {
      connections.getByLocationId.mockResolvedValue(null);
      const client = new TestGhlApiClient(connections, devGuard, gatewayConfig);

      const contact = await client.upsertContact(GW_LOC, {
        phone: "+17865274077",
        firstName: "Ada",
        lastName: null,
        email: null,
      });

      // The write gate short-circuits BEFORE the gateway fallback — dev never
      // POSTs to the real gateway sub-account.
      expect(contact).toBeNull();
      expect(client.transport.request).not.toHaveBeenCalled();
      expect(client.builtFor).toHaveLength(0);
      expect(connections.getByLocationId).not.toHaveBeenCalled();
    });
  });

  describe("reads", () => {
    it("returns the contact on success", async () => {
      connections.getByLocationId.mockResolvedValue(conn());
      const client = new TestGhlApiClient(connections, prodGuard, noGateway);
      client.transport.request.mockResolvedValue(ok({ contact: { id: "ct_1", firstName: "A" } }));

      const contact = await client.getContact("loc_1", "ct_1");
      expect(contact?.id).toBe("ct_1");
    });

    it("returns null when the contact 404s", async () => {
      connections.getByLocationId.mockResolvedValue(conn());
      const client = new TestGhlApiClient(connections, prodGuard, noGateway);
      client.transport.request.mockRejectedValue(axiosError(404));

      expect(await client.getContact("loc_1", "missing")).toBeNull();
      // 404-as-null must NOT trigger retries.
      expect(client.transport.request).toHaveBeenCalledTimes(1);
    });

    it("lists custom fields (empty array when none)", async () => {
      connections.getByLocationId.mockResolvedValue(conn());
      const client = new TestGhlApiClient(connections, prodGuard, noGateway);
      client.transport.request.mockResolvedValue(ok({}));
      expect(await client.listCustomFields("loc_1")).toEqual([]);
    });

    it("finds a contact by phone via the duplicate-search endpoint (JAK-147)", async () => {
      connections.getByLocationId.mockResolvedValue(conn());
      const client = new TestGhlApiClient(connections, prodGuard, noGateway);
      client.transport.request.mockResolvedValue(
        ok({ contact: { id: "ct_1", firstName: "Ada", phone: "+17865274077" } })
      );

      const contact = await client.findContactByPhone("loc_1", "+17865274077");

      expect(contact?.id).toBe("ct_1");
      const call = client.transport.request.mock.calls[0][0];
      expect(call.method).toBe("GET");
      expect(call.url).toBe("/contacts/search/duplicate");
      expect(call.params).toEqual({ locationId: "loc_1", number: "+17865274077" });
    });

    it("returns null (not an error) when no contact matches the phone", async () => {
      connections.getByLocationId.mockResolvedValue(conn());
      const client = new TestGhlApiClient(connections, prodGuard, noGateway);
      client.transport.request.mockRejectedValue(axiosError(404));

      expect(await client.findContactByPhone("loc_1", "+15550000000")).toBeNull();
      // 404-as-null must NOT trigger retries.
      expect(client.transport.request).toHaveBeenCalledTimes(1);
    });

    it("still finds a contact by phone in DEV (a read, not a write)", async () => {
      connections.getByLocationId.mockResolvedValue(conn());
      const client = new TestGhlApiClient(connections, devGuard, noGateway);
      client.transport.request.mockResolvedValue(ok({ contact: { id: "ct_1" } }));

      const contact = await client.findContactByPhone("loc_1", "+17865274077");
      expect(contact?.id).toBe("ct_1");
      expect(client.transport.request).toHaveBeenCalledTimes(1);
    });
  });

  describe("writes + SPEC §8 dev safety", () => {
    it("performs the write in production", async () => {
      connections.getByLocationId.mockResolvedValue(conn());
      const client = new TestGhlApiClient(connections, prodGuard, noGateway);
      client.transport.request.mockResolvedValue(ok({}));

      await client.updateContactCustomFields("loc_1", "ct_1", [
        { key: "ownername", value: "Jane" },
      ]);

      const call = client.transport.request.mock.calls[0][0];
      expect(call.method).toBe("PUT");
      expect(call.url).toBe("/contacts/ct_1");
      expect(call.data).toEqual({ customFields: [{ key: "ownername", value: "Jane" }] });
    });

    it("performs the write in staging (dedicated test sub-account)", async () => {
      connections.getByLocationId.mockResolvedValue(conn());
      const client = new TestGhlApiClient(connections, stagingGuard, noGateway);
      client.transport.request.mockResolvedValue(ok({}));

      await client.updateContactCustomFields("loc_1", "ct_1", [
        { key: "ownername", value: "Jane" },
      ]);

      expect(client.transport.request).toHaveBeenCalledTimes(1);
      expect(client.transport.request.mock.calls[0][0].method).toBe("PUT");
    });

    it("echoes and SKIPS every write in dev (never hits a real location)", async () => {
      connections.getByLocationId.mockResolvedValue(conn());
      const client = new TestGhlApiClient(connections, devGuard, noGateway);

      await client.updateContactCustomFields("loc_1", "ct_1", [{ key: "x", value: 1 }]);
      const note = await client.createNote("loc_1", "ct_1", "hi");
      const field = await client.createCustomField("loc_1", { name: "F", dataType: "TEXT" });

      // The transport is never built or called — the gate short-circuits before
      // even resolving a connection, so dev needs no credentials to stay safe.
      expect(client.transport.request).not.toHaveBeenCalled();
      expect(client.builtFor).toHaveLength(0);
      expect(connections.getByLocationId).not.toHaveBeenCalled();
      expect(note).toBeNull();
      expect(field).toBeNull();
    });

    it("still allows READS in dev (only writes are gated)", async () => {
      connections.getByLocationId.mockResolvedValue(conn());
      const client = new TestGhlApiClient(connections, devGuard, noGateway);
      client.transport.request.mockResolvedValue(ok({ contact: { id: "ct_1" } }));

      const contact = await client.getContact("loc_1", "ct_1");

      expect(contact?.id).toBe("ct_1");
      expect(client.transport.request).toHaveBeenCalledTimes(1);
    });

    it("creates a note and returns it in production", async () => {
      connections.getByLocationId.mockResolvedValue(conn());
      const client = new TestGhlApiClient(connections, prodGuard, noGateway);
      client.transport.request.mockResolvedValue(ok({ note: { id: "n_1", body: "hi" } }));

      const note = await client.createNote("loc_1", "ct_1", "hi");
      expect(note?.id).toBe("n_1");
      expect(client.transport.request.mock.calls[0][0].url).toBe("/contacts/ct_1/notes");
    });

    it("creates a custom field on the location endpoint", async () => {
      connections.getByLocationId.mockResolvedValue(conn());
      const client = new TestGhlApiClient(connections, prodGuard, noGateway);
      client.transport.request.mockResolvedValue(ok({ customField: { id: "cf_1", name: "F" } }));

      const field = await client.createCustomField("loc_1", { name: "F", dataType: "TEXT" });
      expect(field?.id).toBe("cf_1");
      const call = client.transport.request.mock.calls[0][0];
      expect(call.method).toBe("POST");
      expect(call.url).toBe("/locations/loc_1/customFields");
    });

    it("upserts a contact by phone with profile + custom fields in production (JAK-147)", async () => {
      connections.getByLocationId.mockResolvedValue(conn());
      const client = new TestGhlApiClient(connections, prodGuard, noGateway);
      client.transport.request.mockResolvedValue(ok({ contact: { id: "ct_1" } }));

      const contact = await client.upsertContact("loc_1", {
        phone: "+17865274077",
        firstName: "Ada",
        lastName: "Lovelace",
        email: "ada@example.com",
        customFields: [{ id: "f_textjake", value: true }],
      });

      expect(contact?.id).toBe("ct_1");
      const call = client.transport.request.mock.calls[0][0];
      expect(call.method).toBe("POST");
      expect(call.url).toBe("/contacts/upsert");
      expect(call.data).toEqual({
        locationId: "loc_1",
        phone: "+17865274077",
        firstName: "Ada",
        lastName: "Lovelace",
        email: "ada@example.com",
        customFields: [{ id: "f_textjake", value: true }],
      });
    });

    it("omits absent name/email from the upsert payload (never blanks a value)", async () => {
      connections.getByLocationId.mockResolvedValue(conn());
      const client = new TestGhlApiClient(connections, prodGuard, noGateway);
      client.transport.request.mockResolvedValue(ok({ contact: { id: "ct_1" } }));

      await client.upsertContact("loc_1", {
        phone: "+17865274077",
        firstName: null,
        lastName: null,
        email: null,
      });

      expect(client.transport.request.mock.calls[0][0].data).toEqual({
        locationId: "loc_1",
        phone: "+17865274077",
      });
    });

    it("echoes and SKIPS the contact upsert in dev (no real create/update)", async () => {
      connections.getByLocationId.mockResolvedValue(conn());
      const client = new TestGhlApiClient(connections, devGuard, noGateway);

      const contact = await client.upsertContact("loc_1", {
        phone: "+17865274077",
        firstName: "Ada",
        lastName: null,
        email: null,
        customFields: [{ id: "f_textjake", value: true }],
      });

      expect(contact).toBeNull();
      expect(client.transport.request).not.toHaveBeenCalled();
      expect(connections.getByLocationId).not.toHaveBeenCalled();
    });
  });

  describe("sendSms (text-Jake reply, JAK-114)", () => {
    it("posts the SMS to the Conversations API on the location's client", async () => {
      const c = conn({ locationId: "loc_a", baseUrl: "https://a.example.com" });
      connections.getByLocationId.mockResolvedValue(c);
      const client = new TestGhlApiClient(connections, prodGuard, noGateway);
      client.transport.request.mockResolvedValue(ok({ conversationId: "cv_1", messageId: "m_1" }));

      const result = await client.sendSms("loc_a", {
        contactId: "ct_1",
        message: "hi there",
        fromNumber: "+15551230000",
      });

      // Built from THIS location's decrypted creds — never a shared/default key.
      expect(connections.getByLocationId).toHaveBeenCalledWith("loc_a");
      expect(client.builtFor[0].apiKey).toBe(c.apiKey);
      const call = client.transport.request.mock.calls[0][0];
      expect(call.method).toBe("POST");
      expect(call.url).toBe("/conversations/messages");
      expect(call.data).toEqual({
        type: "SMS",
        contactId: "ct_1",
        message: "hi there",
        fromNumber: "+15551230000",
      });
      expect(result?.messageId).toBe("m_1");
    });

    it("omits fromNumber when not provided (GHL uses the location default)", async () => {
      connections.getByLocationId.mockResolvedValue(conn());
      const client = new TestGhlApiClient(connections, prodGuard, noGateway);
      client.transport.request.mockResolvedValue(ok({}));

      await client.sendSms("loc_1", { contactId: "ct_1", message: "hi" });

      expect(client.transport.request.mock.calls[0][0].data).toEqual({
        type: "SMS",
        contactId: "ct_1",
        message: "hi",
      });
    });

    it("echoes and SKIPS the send in dev (never texts a real person)", async () => {
      connections.getByLocationId.mockResolvedValue(conn());
      const client = new TestGhlApiClient(connections, devGuard, noGateway);

      const result = await client.sendSms("loc_1", { contactId: "ct_1", message: "hi" });

      expect(result).toBeNull();
      expect(client.transport.request).not.toHaveBeenCalled();
      expect(connections.getByLocationId).not.toHaveBeenCalled();
    });
  });

  describe("retries + rate-limit backoff", () => {
    it("retries on 429 then succeeds, honouring Retry-After (seconds)", async () => {
      connections.getByLocationId.mockResolvedValue(conn());
      const client = new TestGhlApiClient(connections, prodGuard, noGateway);
      client.transport.request
        .mockRejectedValueOnce(axiosError(429, { "retry-after": "1" }))
        .mockResolvedValueOnce(ok({ contact: { id: "ct_1" } }));

      const contact = await client.getContact("loc_1", "ct_1");
      expect(contact?.id).toBe("ct_1");
      expect(client.transport.request).toHaveBeenCalledTimes(2);
      expect(client.delays[0]).toBe(1000); // 1s from Retry-After
    });

    it("retries on 5xx then succeeds (exponential backoff)", async () => {
      connections.getByLocationId.mockResolvedValue(conn());
      const client = new TestGhlApiClient(connections, prodGuard, noGateway);
      client.transport.request
        .mockRejectedValueOnce(axiosError(503))
        .mockResolvedValueOnce(ok({ customFields: [{ id: "cf" }] }));

      const fields = await client.listCustomFields("loc_1");
      expect(fields).toHaveLength(1);
      expect(client.delays).toHaveLength(1);
      expect(client.delays[0]).toBeGreaterThanOrEqual(500);
    });

    it("retries network errors (no response)", async () => {
      connections.getByLocationId.mockResolvedValue(conn());
      const client = new TestGhlApiClient(connections, prodGuard, noGateway);
      client.transport.request
        .mockRejectedValueOnce(axiosError(undefined))
        .mockResolvedValueOnce(ok({ contact: { id: "ct_1" } }));

      expect((await client.getContact("loc_1", "ct_1"))?.id).toBe("ct_1");
      expect(client.transport.request).toHaveBeenCalledTimes(2);
    });

    it("fails fast on a non-retriable 400 (no retries)", async () => {
      connections.getByLocationId.mockResolvedValue(conn());
      const client = new TestGhlApiClient(connections, prodGuard, noGateway);
      client.transport.request.mockRejectedValue(axiosError(400));

      await expect(client.getContact("loc_1", "ct")).rejects.toBeInstanceOf(GhlApiError);
      expect(client.transport.request).toHaveBeenCalledTimes(1);
      expect(client.delays).toHaveLength(0);
    });

    it("gives up after MAX_RETRIES on persistent 500s", async () => {
      connections.getByLocationId.mockResolvedValue(conn());
      const client = new TestGhlApiClient(connections, prodGuard, noGateway);
      client.transport.request.mockRejectedValue(axiosError(500));

      await expect(client.listCustomFields("loc_1")).rejects.toMatchObject({
        name: "GhlApiError",
        status: 500,
      });
      // initial attempt + 3 retries
      expect(client.transport.request).toHaveBeenCalledTimes(4);
    });
  });
});
