import express, { Express } from "express";
import request from "supertest";
import { mock, MockProxy } from "jest-mock-extended";
import { EnvConfig } from "../../config/envConfig";
import { GhlConnectionService } from "../../ghlEnrichment/connections/GhlConnectionService";
import { GhlConnection } from "../../ghlEnrichment/connections/GhlConnectionTypes";
import { JakeAssistantService } from "../../services/JakeAssistantService";
import { JakeSmsResource } from "../JakeSmsResource";

// Obviously-fake, generated-looking key. NOT a real credential.
const FAKE_MASTER_KEY = "master_fake_unit_test_key_00000000";

const connection = (over: Partial<GhlConnection> = {}): GhlConnection => ({
  id: "11111111-1111-1111-1111-111111111111",
  locationId: "loc_a",
  apiKey: "unused-in-this-layer",
  baseUrl: "https://a.example.com",
  phoneNumbers: ["+15551110000"],
  status: "active",
  createdAt: new Date("2026-07-01T00:00:00Z"),
  updatedAt: new Date("2026-07-01T00:00:00Z"),
  ...over,
});

/**
 * The inbound SMS webhook is where a text is bound to a tenant (JAK-114). These
 * tests prove: it resolves a location by id AND by destination number, it hands
 * the assistant the RESOLVED location (never one from the raw payload), and an
 * unknown number is ignored — no processing, no cross-tenant credential use.
 */
describe("JakeSmsResource (multi-tenant routing)", () => {
  let connections: MockProxy<GhlConnectionService>;
  let assistant: MockProxy<JakeAssistantService>;
  let app: Express;

  beforeEach(() => {
    connections = mock<GhlConnectionService>();
    assistant = mock<JakeAssistantService>();
    assistant.handleInboundMessage.mockResolvedValue({ ok: true, address: null, reply: "hi" });
    const env = { masterApiKey: FAKE_MASTER_KEY } as unknown as EnvConfig;
    const resource = new JakeSmsResource(env, connections, assistant);
    app = express();
    app.use(express.json());
    app.use("/api/sms", resource.router);
  });

  const post = (body: Record<string, unknown>) =>
    request(app).post("/api/sms/inbound").set("x-master-api-key", FAKE_MASTER_KEY).send(body);

  describe("auth", () => {
    it("rejects with no master key (401) and never resolves a tenant", async () => {
      const res = await request(app)
        .post("/api/sms/inbound")
        .send({ locationId: "loc_a", contactId: "ct", message: "hi" });
      expect(res.status).toBe(401);
      expect(connections.getByLocationId).not.toHaveBeenCalled();
      expect(assistant.handleInboundMessage).not.toHaveBeenCalled();
    });
  });

  describe("validation", () => {
    it("400s when contactId or message is missing", async () => {
      const res = await post({ locationId: "loc_a" });
      expect(res.status).toBe(400);
      expect(assistant.handleInboundMessage).not.toHaveBeenCalled();
    });
  });

  describe("tenant resolution", () => {
    it("resolves by GHL locationId and forwards that location to the assistant", async () => {
      connections.getByLocationId.mockResolvedValue(connection({ locationId: "loc_a" }));

      const res = await post({ locationId: "loc_a", contactId: "ct_1", message: "123 Main St" });

      expect(res.status).toBe(200);
      expect(connections.getByLocationId).toHaveBeenCalledWith("loc_a");
      expect(assistant.handleInboundMessage).toHaveBeenCalledWith(
        expect.objectContaining({ locationId: "loc_a", contactId: "ct_1" })
      );
    });

    it("resolves by destination phone number when no locationId is present", async () => {
      connections.getByLocationId.mockResolvedValue(null);
      connections.getByPhoneNumber.mockResolvedValue(
        connection({ locationId: "loc_b", phoneNumbers: ["+15559990000"] })
      );

      const res = await post({ to: "+15559990000", contactId: "ct_1", message: "hi" });

      expect(res.status).toBe(200);
      expect(connections.getByPhoneNumber).toHaveBeenCalledWith("+15559990000");
      expect(assistant.handleInboundMessage).toHaveBeenCalledWith(
        expect.objectContaining({ locationId: "loc_b" })
      );
    });

    it("sends the reply from a number only when it belongs to the resolved tenant", async () => {
      connections.getByLocationId.mockResolvedValue(
        connection({ locationId: "loc_a", phoneNumbers: ["+15551110000"] })
      );

      await post({
        locationId: "loc_a",
        to: "+15551110000",
        contactId: "ct_1",
        message: "hi",
      });

      expect(assistant.handleInboundMessage).toHaveBeenCalledWith(
        expect.objectContaining({ locationId: "loc_a", fromNumber: "+15551110000" })
      );
    });

    it("omits the reply-from number if it is NOT one of the tenant's numbers", async () => {
      connections.getByLocationId.mockResolvedValue(
        connection({ locationId: "loc_a", phoneNumbers: ["+15551110000"] })
      );

      await post({
        locationId: "loc_a",
        to: "+19998887777", // attacker-supplied / foreign number
        contactId: "ct_1",
        message: "hi",
      });

      expect(assistant.handleInboundMessage).toHaveBeenCalledWith(
        expect.objectContaining({ fromNumber: undefined })
      );
    });
  });

  describe("safe rejection (isolation)", () => {
    it("ignores an unknown number/location without processing or leaking creds", async () => {
      connections.getByLocationId.mockResolvedValue(null);
      connections.getByPhoneNumber.mockResolvedValue(null);

      const res = await post({ to: "+10000000000", contactId: "ct_1", message: "hi" });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ok: false, ignored: true, reason: "unknown location" });
      expect(assistant.handleInboundMessage).not.toHaveBeenCalled();
    });

    it("ignores an inactive (uninstalled) location", async () => {
      connections.getByLocationId.mockResolvedValue(connection({ status: "inactive" }));

      const res = await post({ locationId: "loc_a", contactId: "ct_1", message: "hi" });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ok: false, ignored: true, reason: "location inactive" });
      expect(assistant.handleInboundMessage).not.toHaveBeenCalled();
    });

    it("tenant A's inbound never routes to tenant B (locationId is authoritative)", async () => {
      // Store maps loc_a → tenant A only. A payload naming loc_a must resolve to
      // A and be handled on A — never any other tenant.
      connections.getByLocationId.mockImplementation(async (loc) =>
        loc === "loc_a" ? connection({ locationId: "loc_a" }) : null
      );

      await post({ locationId: "loc_a", contactId: "ct_a", message: "hi" });

      const [arg] = assistant.handleInboundMessage.mock.calls[0];
      expect(arg.locationId).toBe("loc_a");
      // Never resolved or handled as any other location.
      expect(connections.getByLocationId).toHaveBeenCalledWith("loc_a");
      expect(connections.getByLocationId).not.toHaveBeenCalledWith("loc_b");
    });
  });
});
