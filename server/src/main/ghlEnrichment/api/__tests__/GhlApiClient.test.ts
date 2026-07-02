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

const prodConfig = {
  isProduction: true,
  isStaging: false,
  isDev: false,
} as GhlEnrichmentConfig;

const devConfig = {
  isProduction: false,
  isStaging: false,
  isDev: true,
} as GhlEnrichmentConfig;

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
      const client = new TestGhlApiClient(connections, prodConfig);
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
      const client = new TestGhlApiClient(connections, prodConfig);
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
      const client = new TestGhlApiClient(connections, prodConfig);
      client.transport.request.mockResolvedValue(ok({ customFields: [] }));

      await client.listCustomFields("loc_1");
      await client.listCustomFields("loc_1");

      expect(client.builtFor).toHaveLength(1);
      expect(connections.getByLocationId).toHaveBeenCalledTimes(1);
    });

    it("sets a Bearer header and base URL from the connection (real builder)", () => {
      const client = new GhlApiClient(connections, prodConfig);
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
      const client = new TestGhlApiClient(connections, prodConfig);
      await expect(client.getContact("missing", "ct")).rejects.toBeInstanceOf(
        GhlConnectionUnavailableError
      );
    });

    it("refuses to use an inactive (uninstalled) connection", async () => {
      connections.getByLocationId.mockResolvedValue(conn({ status: "inactive" }));
      const client = new TestGhlApiClient(connections, prodConfig);
      await expect(client.getContact("loc_1", "ct")).rejects.toBeInstanceOf(
        GhlConnectionUnavailableError
      );
    });
  });

  describe("reads", () => {
    it("returns the contact on success", async () => {
      connections.getByLocationId.mockResolvedValue(conn());
      const client = new TestGhlApiClient(connections, prodConfig);
      client.transport.request.mockResolvedValue(ok({ contact: { id: "ct_1", firstName: "A" } }));

      const contact = await client.getContact("loc_1", "ct_1");
      expect(contact?.id).toBe("ct_1");
    });

    it("returns null when the contact 404s", async () => {
      connections.getByLocationId.mockResolvedValue(conn());
      const client = new TestGhlApiClient(connections, prodConfig);
      client.transport.request.mockRejectedValue(axiosError(404));

      expect(await client.getContact("loc_1", "missing")).toBeNull();
      // 404-as-null must NOT trigger retries.
      expect(client.transport.request).toHaveBeenCalledTimes(1);
    });

    it("lists custom fields (empty array when none)", async () => {
      connections.getByLocationId.mockResolvedValue(conn());
      const client = new TestGhlApiClient(connections, prodConfig);
      client.transport.request.mockResolvedValue(ok({}));
      expect(await client.listCustomFields("loc_1")).toEqual([]);
    });
  });

  describe("writes + SPEC §8 dev safety", () => {
    it("performs the write in production", async () => {
      connections.getByLocationId.mockResolvedValue(conn());
      const client = new TestGhlApiClient(connections, prodConfig);
      client.transport.request.mockResolvedValue(ok({}));

      await client.updateContactCustomFields("loc_1", "ct_1", [
        { key: "ownername", value: "Jane" },
      ]);

      const call = client.transport.request.mock.calls[0][0];
      expect(call.method).toBe("PUT");
      expect(call.url).toBe("/contacts/ct_1");
      expect(call.data).toEqual({ customFields: [{ key: "ownername", value: "Jane" }] });
    });

    it("echoes and SKIPS the write in dev (never hits a real location)", async () => {
      connections.getByLocationId.mockResolvedValue(conn());
      const client = new TestGhlApiClient(connections, devConfig);

      await client.updateContactCustomFields("loc_1", "ct_1", [{ key: "x", value: 1 }]);
      const note = await client.createNote("loc_1", "ct_1", "hi");
      const field = await client.createCustomField("loc_1", { name: "F", dataType: "TEXT" });

      expect(client.transport.request).not.toHaveBeenCalled();
      expect(note).toBeNull();
      expect(field).toBeNull();
    });

    it("creates a note and returns it in production", async () => {
      connections.getByLocationId.mockResolvedValue(conn());
      const client = new TestGhlApiClient(connections, prodConfig);
      client.transport.request.mockResolvedValue(ok({ note: { id: "n_1", body: "hi" } }));

      const note = await client.createNote("loc_1", "ct_1", "hi");
      expect(note?.id).toBe("n_1");
      expect(client.transport.request.mock.calls[0][0].url).toBe("/contacts/ct_1/notes");
    });

    it("creates a custom field on the location endpoint", async () => {
      connections.getByLocationId.mockResolvedValue(conn());
      const client = new TestGhlApiClient(connections, prodConfig);
      client.transport.request.mockResolvedValue(ok({ customField: { id: "cf_1", name: "F" } }));

      const field = await client.createCustomField("loc_1", { name: "F", dataType: "TEXT" });
      expect(field?.id).toBe("cf_1");
      const call = client.transport.request.mock.calls[0][0];
      expect(call.method).toBe("POST");
      expect(call.url).toBe("/locations/loc_1/customFields");
    });
  });

  describe("retries + rate-limit backoff", () => {
    it("retries on 429 then succeeds, honouring Retry-After (seconds)", async () => {
      connections.getByLocationId.mockResolvedValue(conn());
      const client = new TestGhlApiClient(connections, prodConfig);
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
      const client = new TestGhlApiClient(connections, prodConfig);
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
      const client = new TestGhlApiClient(connections, prodConfig);
      client.transport.request
        .mockRejectedValueOnce(axiosError(undefined))
        .mockResolvedValueOnce(ok({ contact: { id: "ct_1" } }));

      expect((await client.getContact("loc_1", "ct_1"))?.id).toBe("ct_1");
      expect(client.transport.request).toHaveBeenCalledTimes(2);
    });

    it("fails fast on a non-retriable 400 (no retries)", async () => {
      connections.getByLocationId.mockResolvedValue(conn());
      const client = new TestGhlApiClient(connections, prodConfig);
      client.transport.request.mockRejectedValue(axiosError(400));

      await expect(client.getContact("loc_1", "ct")).rejects.toBeInstanceOf(GhlApiError);
      expect(client.transport.request).toHaveBeenCalledTimes(1);
      expect(client.delays).toHaveLength(0);
    });

    it("gives up after MAX_RETRIES on persistent 500s", async () => {
      connections.getByLocationId.mockResolvedValue(conn());
      const client = new TestGhlApiClient(connections, prodConfig);
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
