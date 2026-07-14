import { randomUUID } from "crypto";
import { AxiosInstance } from "axios";
import { JakeGatewayClient, JakeGatewayUnavailableError } from "../JakeGatewayClient";
import { GhlEnrichmentConfig } from "../../config/GhlEnrichmentConfig";
import { ExternalActionGuard } from "../../../safety/ExternalActionGuard";

/** A fake axios transport whose `request` we control per test. */
type FakeTransport = { request: jest.Mock };

/** Subclass that swaps the real axios instance for a controllable transport. */
class TestGatewayClient extends JakeGatewayClient {
  public readonly transport: FakeTransport = { request: jest.fn() };
  protected httpClient(): AxiosInstance {
    return this.transport as unknown as AxiosInstance;
  }
}

/**
 * Config with gateway master creds. The api key is generated at runtime so
 * nothing secret-looking is ever committed — but it IS the value the client must
 * authenticate with.
 */
const configWith = (
  over: Partial<{ apiKey: string; locationId: string; baseUrl: string }> = {}
): GhlEnrichmentConfig =>
  ({
    gateway: {
      apiKey: `gw-${randomUUID()}`,
      locationId: "loc_gateway",
      baseUrl: "https://gateway.example.com",
      ...over,
    },
  } as unknown as GhlEnrichmentConfig);

const guardWith = (live: boolean): ExternalActionGuard =>
  ({ liveActionsAllowed: live, echoSkipped: () => {} } as unknown as ExternalActionGuard);

const prodGuard = guardWith(true);
const devGuard = guardWith(false);

const ok = (data: unknown) => ({ data });

describe("JakeGatewayClient (master-key text-Jake gateway)", () => {
  describe("master credential wiring", () => {
    it("builds the client with the MASTER gateway key + base URL from config", () => {
      const config = configWith({ baseUrl: "https://gw.example.com" });
      const client = new JakeGatewayClient(config, prodGuard);

      const http = (client as unknown as { httpClient(): AxiosInstance }).httpClient();

      expect(http.defaults.baseURL).toBe("https://gw.example.com");
      expect(String(http.defaults.headers.Authorization)).toBe(`Bearer ${config.gateway.apiKey}`);
    });

    it("throws JakeGatewayUnavailableError when the master creds are unset", () => {
      const client = new JakeGatewayClient(configWith({ apiKey: "" }), prodGuard);
      expect(() =>
        (client as unknown as { httpClient(): AxiosInstance }).httpClient()
      ).toThrow(JakeGatewayUnavailableError);
    });
  });

  describe("sendSms", () => {
    it("posts the SMS to the Conversations API on the master client (no location id in body)", async () => {
      const client = new TestGatewayClient(configWith(), prodGuard);
      client.transport.request.mockResolvedValue(ok({ messageId: "m_1" }));

      const result = await client.sendSms({ contactId: "ct_1", message: "hi", fromNumber: "+15551110000" });

      const call = client.transport.request.mock.calls[0][0];
      expect(call.method).toBe("POST");
      expect(call.url).toBe("/conversations/messages");
      expect(call.data).toEqual({
        type: "SMS",
        contactId: "ct_1",
        message: "hi",
        fromNumber: "+15551110000",
      });
      expect(result?.messageId).toBe("m_1");
    });

    it("omits fromNumber when not provided (GHL uses the gateway default)", async () => {
      const client = new TestGatewayClient(configWith(), prodGuard);
      client.transport.request.mockResolvedValue(ok({}));

      await client.sendSms({ contactId: "ct_1", message: "hi" });

      expect(client.transport.request.mock.calls[0][0].data).toEqual({
        type: "SMS",
        contactId: "ct_1",
        message: "hi",
      });
    });

    it("echoes and SKIPS the send in dev (never texts a real person)", async () => {
      const client = new TestGatewayClient(configWith(), devGuard);

      const result = await client.sendSms({ contactId: "ct_1", message: "hi" });

      expect(result).toBeNull();
      expect(client.transport.request).not.toHaveBeenCalled();
    });
  });

  describe("createContactNote", () => {
    it("posts the note to the contact's notes endpoint", async () => {
      const client = new TestGatewayClient(configWith(), prodGuard);
      client.transport.request.mockResolvedValue(ok({ note: { id: "n_1", body: "looked up" } }));

      const note = await client.createContactNote("ct_1", "looked up 123 Main St");

      const call = client.transport.request.mock.calls[0][0];
      expect(call.method).toBe("POST");
      expect(call.url).toBe("/contacts/ct_1/notes");
      expect(call.data).toEqual({ body: "looked up 123 Main St" });
      expect(note?.id).toBe("n_1");
    });

    it("echoes and SKIPS the note in dev", async () => {
      const client = new TestGatewayClient(configWith(), devGuard);
      const note = await client.createContactNote("ct_1", "hi");
      expect(note).toBeNull();
      expect(client.transport.request).not.toHaveBeenCalled();
    });
  });
});
