import express, { Express } from "express";
import request from "supertest";
import { mock, MockProxy } from "jest-mock-extended";
import { EnvConfig } from "../../config/envConfig";
import { JakeAssistantService } from "../../services/JakeAssistantService";
import { JakeSmsResource } from "../JakeSmsResource";

// Obviously-fake, generated-looking key. NOT a real credential.
const FAKE_MASTER_KEY = "master_fake_unit_test_key_00000000";

/**
 * The inbound SMS webhook (JAK-115). It authenticates the transport with the
 * app-level MASTER_API_KEY, then normalizes GHL's flexible fields and hands the
 * assistant a clean shape: the SENDER phone (billing identity) plus the routing
 * keys (location id / destination number) the assistant uses to pick the text
 * mode. The resource itself resolves no tenant and touches no GHL credential.
 */
describe("JakeSmsResource", () => {
  let assistant: MockProxy<JakeAssistantService>;
  let app: Express;

  beforeEach(() => {
    assistant = mock<JakeAssistantService>();
    assistant.handleInboundMessage.mockResolvedValue({
      ok: true,
      address: null,
      reply: "hi",
      mode: "gateway",
      charged: 0,
    });
    const env = { masterApiKey: FAKE_MASTER_KEY } as unknown as EnvConfig;
    const resource = new JakeSmsResource(env, assistant);
    app = express();
    app.use(express.json());
    app.use("/api/sms", resource.router);
  });

  const post = (body: Record<string, unknown>) =>
    request(app).post("/api/sms/inbound").set("x-master-api-key", FAKE_MASTER_KEY).send(body);

  describe("auth", () => {
    it("rejects with no master key (401) and never calls the assistant", async () => {
      const res = await request(app)
        .post("/api/sms/inbound")
        .send({ from: "+15559990000", contactId: "ct", message: "hi" });
      expect(res.status).toBe(401);
      expect(assistant.handleInboundMessage).not.toHaveBeenCalled();
    });
  });

  describe("validation", () => {
    it("400s when contactId or message is missing", async () => {
      const res = await post({ from: "+15559990000" });
      expect(res.status).toBe(400);
      expect(assistant.handleInboundMessage).not.toHaveBeenCalled();
    });

    it("400s when the sender phone is missing (no billing identity)", async () => {
      const res = await post({ contactId: "ct", message: "hi" });
      expect(res.status).toBe(400);
      expect(assistant.handleInboundMessage).not.toHaveBeenCalled();
    });
  });

  describe("normalization → assistant", () => {
    it("forwards sender phone + routing keys and returns the assistant result", async () => {
      const res = await post({
        contactId: "ct_1",
        message: "123 Main St",
        from: "+15559990000",
        locationId: "loc_a",
        to: "+15551110000",
      });

      expect(res.status).toBe(200);
      expect(assistant.handleInboundMessage).toHaveBeenCalledWith({
        contactId: "ct_1",
        senderPhone: "+15559990000",
        message: "123 Main St",
        locationId: "loc_a",
        candidateNumbers: ["+15551110000"],
      });
    });

    it("accepts GHL's alternate field names (phone / contact_id / body)", async () => {
      await post({ contact_id: "ct_2", body: "hi", phone: "+15557770000" });

      expect(assistant.handleInboundMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          contactId: "ct_2",
          senderPhone: "+15557770000",
          message: "hi",
        })
      );
    });

    it("two different senders are forwarded with their own phone (billing isolation)", async () => {
      await post({ contactId: "ct_a", message: "hi", from: "+15550001111" });
      await post({ contactId: "ct_b", message: "hi", from: "+15550002222" });

      const senders = assistant.handleInboundMessage.mock.calls.map(([m]) => m.senderPhone);
      expect(senders).toEqual(["+15550001111", "+15550002222"]);
    });
  });
});
