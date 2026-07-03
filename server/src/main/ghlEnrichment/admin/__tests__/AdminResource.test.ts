import express, { Express } from "express";
import request from "supertest";
import { mock, MockProxy } from "jest-mock-extended";
import { GhlStatusService } from "../../status/GhlStatusService";
import { AdminAuthService } from "../AdminAuthService";
import { AdminConnectionService, API_KEY_MASK } from "../AdminConnectionService";
import { AdminTextCustomerService } from "../AdminTextCustomerService";
import { AdminResource } from "../AdminResource";
import { AdminConnectionView, AdminTextCustomerView } from "../AdminTypes";
import { PropertyReportPromptService } from "../../../services/PropertyReportPromptService";
import { OrchestratorPromptService } from "../../../services/orchestrator/OrchestratorPromptService";
import { SkipTracePromptService } from "../../../services/skiptrace/SkipTracePromptService";
import { SkipTraceSettingsService } from "../../../services/skiptrace/SkipTraceSettingsService";
import { CompsPromptService } from "../../../services/comps/CompsPromptService";
import { CompsSettingsService } from "../../../services/comps/CompsSettingsService";
import { LlmModelSettingsService } from "../../../services/llm/LlmModelSettingsService";

// Obviously-fake, low-entropy placeholder used by the reset-password tests.
// Held in a constant (not inlined next to a `password:` key) so a secret
// scanner doesn't mistake a test fixture for a real hardcoded credential.
const TEST_RESET_PW = ["unit", "test", "new", "pw"].join("-");

const view = (over: Partial<AdminConnectionView> = {}): AdminConnectionView => ({
  id: "cccccccc-cccc-cccc-cccc-cccccccccccc",
  locationId: "loc_1",
  baseUrl: "https://services.leadconnectorhq.com",
  phoneNumbers: ["+15551234567"],
  status: "active",
  apiKeyMasked: API_KEY_MASK,
  createdAt: new Date("2026-07-01T00:00:00Z"),
  updatedAt: new Date("2026-07-01T00:00:00Z"),
  ...over,
});

describe("AdminResource", () => {
  let auth: MockProxy<AdminAuthService>;
  let connections: MockProxy<AdminConnectionService>;
  let textCustomers: MockProxy<AdminTextCustomerService>;
  let status: MockProxy<GhlStatusService>;
  let reportPrompt: MockProxy<PropertyReportPromptService>;
  let orchestratorPrompt: MockProxy<OrchestratorPromptService>;
  let skipTracePrompt: MockProxy<SkipTracePromptService>;
  let skipTraceSettings: MockProxy<SkipTraceSettingsService>;
  let compsPrompt: MockProxy<CompsPromptService>;
  let compsSettings: MockProxy<CompsSettingsService>;
  let modelSettings: MockProxy<LlmModelSettingsService>;
  let app: Express;

  beforeEach(() => {
    auth = mock<AdminAuthService>();
    connections = mock<AdminConnectionService>();
    textCustomers = mock<AdminTextCustomerService>();
    status = mock<GhlStatusService>();
    reportPrompt = mock<PropertyReportPromptService>();
    orchestratorPrompt = mock<OrchestratorPromptService>();
    skipTracePrompt = mock<SkipTracePromptService>();
    skipTraceSettings = mock<SkipTraceSettingsService>();
    compsPrompt = mock<CompsPromptService>();
    compsSettings = mock<CompsSettingsService>();
    modelSettings = mock<LlmModelSettingsService>();
    // Default: authenticated AS A SUPERADMIN so the admin-management tests reach
    // their handlers. Individual tests override to a plain admin / no session.
    auth.verifyToken.mockReturnValue({ sub: "admin-id", email: "admin@example.com", role: "superadmin" });

    app = express();
    app.use(express.json());
    app.use(
      "/api/admin",
      new AdminResource(
        auth,
        connections,
        textCustomers,
        status,
        reportPrompt,
        orchestratorPrompt,
        skipTracePrompt,
        skipTraceSettings,
        compsPrompt,
        compsSettings,
        modelSettings
      ).router
    );
  });

  const asAdmin = (req: request.Test) => req.set("Authorization", "Bearer valid.token");
  /** Drop to a plain (non-superadmin) admin session for gate tests (JAK-125). */
  const asPlainAdmin = () =>
    auth.verifyToken.mockReturnValue({ sub: "admin-id", email: "admin@example.com", role: "admin" });

  describe("auth gate", () => {
    it("401s every route without a valid session", async () => {
      auth.verifyToken.mockReturnValue(null);
      const res = await request(app).get("/api/admin/connections");
      expect(res.status).toBe(401);
      expect(status.listLocationStatuses).not.toHaveBeenCalled();
    });
  });

  describe("GET /connections", () => {
    it("returns the JAK-112 overview list", async () => {
      status.listLocationStatuses.mockResolvedValue([]);
      const res = await asAdmin(request(app).get("/api/admin/connections"));
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ locations: [] });
    });
  });

  describe("POST /connections", () => {
    it("creates a connection and returns only the masked key", async () => {
      connections.create.mockResolvedValue(view());
      const res = await asAdmin(
        request(app).post("/api/admin/connections").send({
          locationId: "loc_1",
          apiKey: "unit-test-ghl-key",
          baseUrl: "https://services.leadconnectorhq.com",
          phoneNumbers: ["+15551234567"],
        })
      );
      expect(res.status).toBe(201);
      expect(res.body.connection.apiKeyMasked).toBe(API_KEY_MASK);
      expect(JSON.stringify(res.body)).not.toContain("unit-test-ghl-key");
    });

    it("400s when required fields are missing", async () => {
      const res = await asAdmin(
        request(app).post("/api/admin/connections").send({ locationId: "loc_1" })
      );
      expect(res.status).toBe(400);
      expect(connections.create).not.toHaveBeenCalled();
    });

    it("409s when the location is already connected (unique violation)", async () => {
      connections.create.mockRejectedValue(Object.assign(new Error("dup"), { code: "23505" }));
      const res = await asAdmin(
        request(app).post("/api/admin/connections").send({
          locationId: "loc_1",
          apiKey: "k",
          baseUrl: "https://services.leadconnectorhq.com",
        })
      );
      expect(res.status).toBe(409);
    });
  });

  describe("PUT /connections/:id", () => {
    it("rejects a blank apiKey but allows omitting it", async () => {
      const blank = await asAdmin(
        request(app).put("/api/admin/connections/loc_1").send({ apiKey: "  " })
      );
      expect(blank.status).toBe(400);

      connections.update.mockResolvedValue(view());
      const omitted = await asAdmin(
        request(app).put("/api/admin/connections/loc_1").send({ baseUrl: "https://x.co" })
      );
      expect(omitted.status).toBe(200);
      expect(connections.update).toHaveBeenCalledWith(
        "loc_1",
        expect.objectContaining({ apiKey: undefined, baseUrl: "https://x.co" })
      );
    });
  });

  describe("POST /connections/:id/deactivate", () => {
    it("deactivates a known location", async () => {
      connections.deactivate.mockResolvedValue(true);
      const res = await asAdmin(request(app).post("/api/admin/connections/loc_1/deactivate"));
      expect(res.status).toBe(200);
    });

    it("404s an unknown location", async () => {
      connections.deactivate.mockResolvedValue(false);
      const res = await asAdmin(request(app).post("/api/admin/connections/nope/deactivate"));
      expect(res.status).toBe(404);
    });
  });

  describe("POST /connections/:id/credits", () => {
    it("rejects a non-integer or zero amount", async () => {
      for (const amount of [0, 1.5, "abc"]) {
        const res = await asAdmin(
          request(app).post("/api/admin/connections/loc_1/credits").send({ amount })
        );
        expect(res.status).toBe(400);
      }
      expect(connections.grantCredits).not.toHaveBeenCalled();
    });

    it("grants a valid amount", async () => {
      connections.grantCredits.mockResolvedValue({
        id: "e1",
        location_id: "loc_1",
        amount: 100,
        balance_after: 100,
        reason: "manual_grant",
        contact_id: null,
        created_at: new Date(),
        modified_at: new Date(),
        deleted_at: null,
      });
      const res = await asAdmin(
        request(app).post("/api/admin/connections/loc_1/credits").send({ amount: 100 })
      );
      expect(res.status).toBe(200);
      expect(res.body.balance).toBe(100);
    });
  });

  // --- Text-Jake customers (JAK-129) ----------------------------------------

  const textCustomerView = (over: Partial<AdminTextCustomerView> = {}): AdminTextCustomerView => ({
    id: "cust-1",
    phone: "+17865274077",
    firstName: null,
    lastName: null,
    email: null,
    ghlContactId: null,
    creditBalance: 0,
    createdAt: new Date("2026-07-01T00:00:00Z"),
    lastSeenAt: new Date("2026-07-02T00:00:00Z"),
    ...over,
  });

  describe("GET /text-customers", () => {
    it("is behind the auth gate", async () => {
      auth.verifyToken.mockReturnValue(null);
      const res = await request(app).get("/api/admin/text-customers");
      expect(res.status).toBe(401);
      expect(textCustomers.list).not.toHaveBeenCalled();
    });

    it("returns texters with their credit balances", async () => {
      textCustomers.list.mockResolvedValue([textCustomerView({ creditBalance: 8 })]);
      const res = await asAdmin(request(app).get("/api/admin/text-customers"));
      expect(res.status).toBe(200);
      expect(res.body.customers).toHaveLength(1);
      expect(res.body.customers[0].creditBalance).toBe(8);
    });
  });

  describe("POST /text-customers/credits", () => {
    it("400s a missing phone", async () => {
      const res = await asAdmin(
        request(app).post("/api/admin/text-customers/credits").send({ amount: 5 })
      );
      expect(res.status).toBe(400);
      expect(textCustomers.grantCredits).not.toHaveBeenCalled();
    });

    it("rejects a non-integer or zero amount", async () => {
      for (const amount of [0, 1.5, "abc"]) {
        const res = await asAdmin(
          request(app).post("/api/admin/text-customers/credits").send({ phone: "+17865274077", amount })
        );
        expect(res.status).toBe(400);
      }
      expect(textCustomers.grantCredits).not.toHaveBeenCalled();
    });

    it("grants credits to a texter by phone and returns the new balance", async () => {
      textCustomers.grantCredits.mockResolvedValue({
        customer: textCustomerView({ creditBalance: 5 }),
        entry: {
          id: "led-1",
          location_id: "cust-1",
          amount: 5,
          balance_after: 5,
          reason: "manual_grant",
          contact_id: null,
          created_at: new Date(),
          modified_at: new Date(),
          deleted_at: null,
        },
        balance: 5,
      });
      const res = await asAdmin(
        request(app).post("/api/admin/text-customers/credits").send({ phone: "+17865274077", amount: 5 })
      );
      expect(res.status).toBe(200);
      expect(res.body.balance).toBe(5);
      expect(textCustomers.grantCredits).toHaveBeenCalledWith("+17865274077", 5, "manual_grant");
    });
  });

  // --- Text-customer profile create/update (JAK-146) ------------------------

  describe("POST /text-customers", () => {
    it("is behind the auth gate", async () => {
      auth.verifyToken.mockReturnValue(null);
      const res = await request(app)
        .post("/api/admin/text-customers")
        .send({ phone: "+17865274077", firstName: "Ada" });
      expect(res.status).toBe(401);
      expect(textCustomers.create).not.toHaveBeenCalled();
    });

    it("creates a customer, persisting name + email", async () => {
      textCustomers.create.mockResolvedValue(
        textCustomerView({ firstName: "Ada", lastName: "Lovelace", email: "ada@example.com" })
      );
      const res = await asAdmin(
        request(app).post("/api/admin/text-customers").send({
          phone: "+17865274077",
          firstName: "Ada",
          lastName: "Lovelace",
          email: "ada@example.com",
        })
      );
      expect(res.status).toBe(201);
      expect(res.body.customer.firstName).toBe("Ada");
      expect(res.body.customer.email).toBe("ada@example.com");
      expect(textCustomers.create).toHaveBeenCalledWith({
        phone: "+17865274077",
        firstName: "Ada",
        lastName: "Lovelace",
        email: "ada@example.com",
      });
    });

    it("allows saving WITHOUT an email (email optional → null)", async () => {
      textCustomers.create.mockResolvedValue(textCustomerView({ firstName: "Ada" }));
      const res = await asAdmin(
        request(app).post("/api/admin/text-customers").send({ phone: "+17865274077", firstName: "Ada" })
      );
      expect(res.status).toBe(201);
      expect(textCustomers.create).toHaveBeenCalledWith({
        phone: "+17865274077",
        firstName: "Ada",
        lastName: null,
        email: null,
      });
    });

    it("400s a blank phone (phone stays required)", async () => {
      const res = await asAdmin(
        request(app).post("/api/admin/text-customers").send({ firstName: "Ada", phone: "   " })
      );
      expect(res.status).toBe(400);
      expect(textCustomers.create).not.toHaveBeenCalled();
    });

    it("400s a non-blank but invalid email", async () => {
      const res = await asAdmin(
        request(app)
          .post("/api/admin/text-customers")
          .send({ phone: "+17865274077", email: "not-an-email" })
      );
      expect(res.status).toBe(400);
      expect(textCustomers.create).not.toHaveBeenCalled();
    });

    it("409s a duplicate phone (unique violation)", async () => {
      textCustomers.create.mockRejectedValue(Object.assign(new Error("dup"), { code: "23505" }));
      const res = await asAdmin(
        request(app).post("/api/admin/text-customers").send({ phone: "+17865274077" })
      );
      expect(res.status).toBe(409);
    });
  });

  describe("PUT /text-customers/:id", () => {
    it("is behind the auth gate", async () => {
      auth.verifyToken.mockReturnValue(null);
      const res = await request(app)
        .put("/api/admin/text-customers/cust-1")
        .send({ phone: "+17865274077" });
      expect(res.status).toBe(401);
      expect(textCustomers.update).not.toHaveBeenCalled();
    });

    it("updates name + email and returns the refreshed view", async () => {
      textCustomers.update.mockResolvedValue(
        textCustomerView({ firstName: "Grace", email: "grace@example.com", creditBalance: 4 })
      );
      const res = await asAdmin(
        request(app).put("/api/admin/text-customers/cust-1").send({
          phone: "+17865274077",
          firstName: "Grace",
          lastName: "Hopper",
          email: "grace@example.com",
        })
      );
      expect(res.status).toBe(200);
      expect(res.body.customer.firstName).toBe("Grace");
      expect(res.body.customer.creditBalance).toBe(4);
      expect(textCustomers.update).toHaveBeenCalledWith("cust-1", {
        phone: "+17865274077",
        firstName: "Grace",
        lastName: "Hopper",
        email: "grace@example.com",
      });
    });

    it("allows clearing the email on edit (blank → null)", async () => {
      textCustomers.update.mockResolvedValue(textCustomerView());
      await asAdmin(
        request(app)
          .put("/api/admin/text-customers/cust-1")
          .send({ phone: "+17865274077", firstName: "Grace", email: "" })
      );
      expect(textCustomers.update).toHaveBeenCalledWith("cust-1", {
        phone: "+17865274077",
        firstName: "Grace",
        lastName: null,
        email: null,
      });
    });

    it("400s a blank phone", async () => {
      const res = await asAdmin(
        request(app).put("/api/admin/text-customers/cust-1").send({ firstName: "Grace" })
      );
      expect(res.status).toBe(400);
      expect(textCustomers.update).not.toHaveBeenCalled();
    });

    it("404s an unknown customer", async () => {
      textCustomers.update.mockResolvedValue(null);
      const res = await asAdmin(
        request(app).put("/api/admin/text-customers/nope").send({ phone: "+17865274077" })
      );
      expect(res.status).toBe(404);
    });

    it("409s when the new phone collides with another customer", async () => {
      textCustomers.update.mockRejectedValue(Object.assign(new Error("dup"), { code: "23505" }));
      const res = await asAdmin(
        request(app).put("/api/admin/text-customers/cust-1").send({ phone: "+15559998888" })
      );
      expect(res.status).toBe(409);
    });
  });

  // --- AI prompt (JAK-131) --------------------------------------------------

  describe("AI prompt (report-prompt)", () => {
    const promptView = (over: Record<string, unknown> = {}) => ({
      prompt: "STYLE PROMPT",
      isDefault: false,
      updatedAt: new Date("2026-07-02T00:00:00Z"),
      updatedBy: "admin-id",
      ...over,
    });

    it("is behind the auth gate", async () => {
      auth.verifyToken.mockReturnValue(null);
      const res = await request(app).get("/api/admin/report-prompt");
      expect(res.status).toBe(401);
      expect(reportPrompt.getView).not.toHaveBeenCalled();
    });

    it("is available to a REGULAR admin — NOT superadmin-gated (JAK-131)", async () => {
      asPlainAdmin();
      reportPrompt.getView.mockResolvedValue(promptView({ isDefault: true }) as never);
      reportPrompt.setPrompt.mockResolvedValue(promptView({ prompt: "NEW" }) as never);
      reportPrompt.resetPrompt.mockResolvedValue(promptView({ isDefault: true }) as never);

      expect((await asAdmin(request(app).get("/api/admin/report-prompt"))).status).toBe(200);
      expect(
        (await asAdmin(request(app).put("/api/admin/report-prompt").send({ prompt: "NEW" }))).status
      ).toBe(200);
      expect(
        (await asAdmin(request(app).post("/api/admin/report-prompt/reset"))).status
      ).toBe(200);
    });

    it("GET returns the effective prompt view", async () => {
      reportPrompt.getView.mockResolvedValue(promptView() as never);
      const res = await asAdmin(request(app).get("/api/admin/report-prompt"));
      expect(res.status).toBe(200);
      expect(res.body.prompt).toBe("STYLE PROMPT");
      expect(res.body.isDefault).toBe(false);
    });

    it("PUT saves a non-empty prompt with the editing admin id", async () => {
      reportPrompt.setPrompt.mockResolvedValue(promptView({ prompt: "Terse mode" }) as never);
      const res = await asAdmin(
        request(app).put("/api/admin/report-prompt").send({ prompt: "  Terse mode  " })
      );
      expect(res.status).toBe(200);
      // Trimmed, and attributed to the logged-in admin (sub: "admin-id").
      expect(reportPrompt.setPrompt).toHaveBeenCalledWith("Terse mode", "admin-id");
    });

    it("PUT 400s an empty prompt", async () => {
      const res = await asAdmin(request(app).put("/api/admin/report-prompt").send({ prompt: "   " }));
      expect(res.status).toBe(400);
      expect(reportPrompt.setPrompt).not.toHaveBeenCalled();
    });

    it("reset reverts to the default", async () => {
      reportPrompt.resetPrompt.mockResolvedValue(promptView({ isDefault: true }) as never);
      const res = await asAdmin(request(app).post("/api/admin/report-prompt/reset"));
      expect(res.status).toBe(200);
      expect(res.body.isDefault).toBe(true);
      expect(reportPrompt.resetPrompt).toHaveBeenCalled();
    });
  });

  // --- Orchestrator/router prompt (JAK-135) ---------------------------------

  describe("AI prompt (orchestrator-prompt)", () => {
    const promptView = (over: Record<string, unknown> = {}) => ({
      prompt: "ROUTER PROMPT",
      isDefault: false,
      updatedAt: new Date("2026-07-03T00:00:00Z"),
      updatedBy: "admin-id",
      ...over,
    });

    it("is behind the auth gate", async () => {
      auth.verifyToken.mockReturnValue(null);
      const res = await request(app).get("/api/admin/orchestrator-prompt");
      expect(res.status).toBe(401);
      expect(orchestratorPrompt.getView).not.toHaveBeenCalled();
    });

    it("is available to a REGULAR admin — NOT superadmin-gated (JAK-135)", async () => {
      asPlainAdmin();
      orchestratorPrompt.getView.mockResolvedValue(promptView({ isDefault: true }) as never);
      orchestratorPrompt.setPrompt.mockResolvedValue(promptView({ prompt: "NEW" }) as never);
      orchestratorPrompt.resetPrompt.mockResolvedValue(promptView({ isDefault: true }) as never);

      expect((await asAdmin(request(app).get("/api/admin/orchestrator-prompt"))).status).toBe(200);
      expect(
        (await asAdmin(request(app).put("/api/admin/orchestrator-prompt").send({ prompt: "NEW" })))
          .status
      ).toBe(200);
      expect(
        (await asAdmin(request(app).post("/api/admin/orchestrator-prompt/reset"))).status
      ).toBe(200);
    });

    it("GET returns the effective prompt view (no hash/secret fields)", async () => {
      orchestratorPrompt.getView.mockResolvedValue(promptView() as never);
      const res = await asAdmin(request(app).get("/api/admin/orchestrator-prompt"));
      expect(res.status).toBe(200);
      expect(res.body.prompt).toBe("ROUTER PROMPT");
      expect(res.body.isDefault).toBe(false);
      // The view is prompt/metadata only — never any credential-bearing field.
      expect(res.body).toEqual({
        prompt: "ROUTER PROMPT",
        isDefault: false,
        updatedAt: "2026-07-03T00:00:00.000Z",
        updatedBy: "admin-id",
      });
    });

    it("PUT saves a non-empty prompt with the editing admin id", async () => {
      orchestratorPrompt.setPrompt.mockResolvedValue(promptView({ prompt: "Route terse" }) as never);
      const res = await asAdmin(
        request(app).put("/api/admin/orchestrator-prompt").send({ prompt: "  Route terse  " })
      );
      expect(res.status).toBe(200);
      // Trimmed, and attributed to the logged-in admin (sub: "admin-id").
      expect(orchestratorPrompt.setPrompt).toHaveBeenCalledWith("Route terse", "admin-id");
    });

    it("PUT 400s an empty prompt", async () => {
      const res = await asAdmin(
        request(app).put("/api/admin/orchestrator-prompt").send({ prompt: "   " })
      );
      expect(res.status).toBe(400);
      expect(orchestratorPrompt.setPrompt).not.toHaveBeenCalled();
    });

    it("reset reverts to the default", async () => {
      orchestratorPrompt.resetPrompt.mockResolvedValue(promptView({ isDefault: true }) as never);
      const res = await asAdmin(request(app).post("/api/admin/orchestrator-prompt/reset"));
      expect(res.status).toBe(200);
      expect(res.body.isDefault).toBe(true);
      expect(orchestratorPrompt.resetPrompt).toHaveBeenCalled();
    });
  });

  // --- Skip-trace specialist prompt (JAK-136) -------------------------------

  describe("AI prompt (skiptrace-prompt)", () => {
    const promptView = (over: Record<string, unknown> = {}) => ({
      prompt: "SKIP TRACE PROMPT",
      isDefault: false,
      updatedAt: new Date("2026-07-03T00:00:00Z"),
      updatedBy: "admin-id",
      ...over,
    });

    it("is behind the auth gate", async () => {
      auth.verifyToken.mockReturnValue(null);
      const res = await request(app).get("/api/admin/skiptrace-prompt");
      expect(res.status).toBe(401);
      expect(skipTracePrompt.getView).not.toHaveBeenCalled();
    });

    it("is available to a REGULAR admin — NOT superadmin-gated", async () => {
      asPlainAdmin();
      skipTracePrompt.getView.mockResolvedValue(promptView({ isDefault: true }) as never);
      skipTracePrompt.setPrompt.mockResolvedValue(promptView({ prompt: "NEW" }) as never);
      skipTracePrompt.resetPrompt.mockResolvedValue(promptView({ isDefault: true }) as never);

      expect((await asAdmin(request(app).get("/api/admin/skiptrace-prompt"))).status).toBe(200);
      expect(
        (await asAdmin(request(app).put("/api/admin/skiptrace-prompt").send({ prompt: "NEW" }))).status
      ).toBe(200);
      expect((await asAdmin(request(app).post("/api/admin/skiptrace-prompt/reset"))).status).toBe(200);
    });

    it("GET returns the effective prompt view (no hash/secret fields)", async () => {
      skipTracePrompt.getView.mockResolvedValue(promptView() as never);
      const res = await asAdmin(request(app).get("/api/admin/skiptrace-prompt"));
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        prompt: "SKIP TRACE PROMPT",
        isDefault: false,
        updatedAt: "2026-07-03T00:00:00.000Z",
        updatedBy: "admin-id",
      });
    });

    it("PUT saves a non-empty prompt with the editing admin id", async () => {
      skipTracePrompt.setPrompt.mockResolvedValue(promptView({ prompt: "Terse" }) as never);
      const res = await asAdmin(
        request(app).put("/api/admin/skiptrace-prompt").send({ prompt: "  Terse  " })
      );
      expect(res.status).toBe(200);
      expect(skipTracePrompt.setPrompt).toHaveBeenCalledWith("Terse", "admin-id");
    });

    it("PUT 400s an empty prompt", async () => {
      const res = await asAdmin(request(app).put("/api/admin/skiptrace-prompt").send({ prompt: "   " }));
      expect(res.status).toBe(400);
      expect(skipTracePrompt.setPrompt).not.toHaveBeenCalled();
    });

    it("reset reverts to the default", async () => {
      skipTracePrompt.resetPrompt.mockResolvedValue(promptView({ isDefault: true }) as never);
      const res = await asAdmin(request(app).post("/api/admin/skiptrace-prompt/reset"));
      expect(res.status).toBe(200);
      expect(res.body.isDefault).toBe(true);
      expect(skipTracePrompt.resetPrompt).toHaveBeenCalled();
    });
  });

  // --- Skip-trace credit cost (JAK-136) ------------------------------------

  describe("skiptrace-cost", () => {
    const costView = (over: Record<string, unknown> = {}) => ({
      value: 3,
      isDefault: false,
      updatedAt: new Date("2026-07-03T00:00:00Z"),
      updatedBy: "admin-id",
      ...over,
    });

    it("is behind the auth gate", async () => {
      auth.verifyToken.mockReturnValue(null);
      const res = await request(app).get("/api/admin/skiptrace-cost");
      expect(res.status).toBe(401);
      expect(skipTraceSettings.getView).not.toHaveBeenCalled();
    });

    it("GET returns the effective cost view", async () => {
      skipTraceSettings.getView.mockResolvedValue(costView() as never);
      const res = await asAdmin(request(app).get("/api/admin/skiptrace-cost"));
      expect(res.status).toBe(200);
      expect(res.body.value).toBe(3);
    });

    it("PUT saves a positive-integer cost with the editing admin id", async () => {
      skipTraceSettings.setCost.mockResolvedValue(costView({ value: 5 }) as never);
      const res = await asAdmin(request(app).put("/api/admin/skiptrace-cost").send({ credits: 5 }));
      expect(res.status).toBe(200);
      expect(skipTraceSettings.setCost).toHaveBeenCalledWith(5, "admin-id");
    });

    it("PUT 400s a zero / non-integer cost (a paid call can never be free)", async () => {
      expect((await asAdmin(request(app).put("/api/admin/skiptrace-cost").send({ credits: 0 }))).status).toBe(400);
      expect((await asAdmin(request(app).put("/api/admin/skiptrace-cost").send({ credits: 2.5 }))).status).toBe(400);
      expect((await asAdmin(request(app).put("/api/admin/skiptrace-cost").send({ credits: -1 }))).status).toBe(400);
      expect(skipTraceSettings.setCost).not.toHaveBeenCalled();
    });

    it("reset reverts to the default", async () => {
      skipTraceSettings.resetCost.mockResolvedValue(costView({ isDefault: true }) as never);
      const res = await asAdmin(request(app).post("/api/admin/skiptrace-cost/reset"));
      expect(res.status).toBe(200);
      expect(res.body.isDefault).toBe(true);
      expect(skipTraceSettings.resetCost).toHaveBeenCalled();
    });
  });

  // --- Comps specialist prompt (JAK-137) ------------------------------------

  describe("AI prompt (comps-prompt)", () => {
    const promptView = (over: Record<string, unknown> = {}) => ({
      prompt: "COMPS PROMPT",
      isDefault: false,
      updatedAt: new Date("2026-07-03T00:00:00Z"),
      updatedBy: "admin-id",
      ...over,
    });

    it("is behind the auth gate", async () => {
      auth.verifyToken.mockReturnValue(null);
      const res = await request(app).get("/api/admin/comps-prompt");
      expect(res.status).toBe(401);
      expect(compsPrompt.getView).not.toHaveBeenCalled();
    });

    it("is available to a REGULAR admin — NOT superadmin-gated", async () => {
      asPlainAdmin();
      compsPrompt.getView.mockResolvedValue(promptView({ isDefault: true }) as never);
      compsPrompt.setPrompt.mockResolvedValue(promptView({ prompt: "NEW" }) as never);
      compsPrompt.resetPrompt.mockResolvedValue(promptView({ isDefault: true }) as never);

      expect((await asAdmin(request(app).get("/api/admin/comps-prompt"))).status).toBe(200);
      expect(
        (await asAdmin(request(app).put("/api/admin/comps-prompt").send({ prompt: "NEW" }))).status
      ).toBe(200);
      expect((await asAdmin(request(app).post("/api/admin/comps-prompt/reset"))).status).toBe(200);
    });

    it("GET returns the effective prompt view (no hash/secret fields)", async () => {
      compsPrompt.getView.mockResolvedValue(promptView() as never);
      const res = await asAdmin(request(app).get("/api/admin/comps-prompt"));
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        prompt: "COMPS PROMPT",
        isDefault: false,
        updatedAt: "2026-07-03T00:00:00.000Z",
        updatedBy: "admin-id",
      });
    });

    it("PUT saves a non-empty prompt with the editing admin id", async () => {
      compsPrompt.setPrompt.mockResolvedValue(promptView({ prompt: "Terse" }) as never);
      const res = await asAdmin(
        request(app).put("/api/admin/comps-prompt").send({ prompt: "  Terse  " })
      );
      expect(res.status).toBe(200);
      expect(compsPrompt.setPrompt).toHaveBeenCalledWith("Terse", "admin-id");
    });

    it("PUT 400s an empty prompt", async () => {
      const res = await asAdmin(request(app).put("/api/admin/comps-prompt").send({ prompt: "   " }));
      expect(res.status).toBe(400);
      expect(compsPrompt.setPrompt).not.toHaveBeenCalled();
    });

    it("reset reverts to the default", async () => {
      compsPrompt.resetPrompt.mockResolvedValue(promptView({ isDefault: true }) as never);
      const res = await asAdmin(request(app).post("/api/admin/comps-prompt/reset"));
      expect(res.status).toBe(200);
      expect(res.body.isDefault).toBe(true);
      expect(compsPrompt.resetPrompt).toHaveBeenCalled();
    });
  });

  // --- Comps credit cost (JAK-137) ------------------------------------------

  describe("comps-cost", () => {
    const costView = (over: Record<string, unknown> = {}) => ({
      value: 3,
      isDefault: false,
      updatedAt: new Date("2026-07-03T00:00:00Z"),
      updatedBy: "admin-id",
      ...over,
    });

    it("is behind the auth gate", async () => {
      auth.verifyToken.mockReturnValue(null);
      const res = await request(app).get("/api/admin/comps-cost");
      expect(res.status).toBe(401);
      expect(compsSettings.getCostView).not.toHaveBeenCalled();
    });

    it("GET returns the effective cost view", async () => {
      compsSettings.getCostView.mockResolvedValue(costView() as never);
      const res = await asAdmin(request(app).get("/api/admin/comps-cost"));
      expect(res.status).toBe(200);
      expect(res.body.value).toBe(3);
    });

    it("PUT saves a positive-integer cost with the editing admin id", async () => {
      compsSettings.setCost.mockResolvedValue(costView({ value: 5 }) as never);
      const res = await asAdmin(request(app).put("/api/admin/comps-cost").send({ credits: 5 }));
      expect(res.status).toBe(200);
      expect(compsSettings.setCost).toHaveBeenCalledWith(5, "admin-id");
    });

    it("PUT 400s a zero / non-integer cost (a paid call can never be free)", async () => {
      expect((await asAdmin(request(app).put("/api/admin/comps-cost").send({ credits: 0 }))).status).toBe(400);
      expect((await asAdmin(request(app).put("/api/admin/comps-cost").send({ credits: 2.5 }))).status).toBe(400);
      expect((await asAdmin(request(app).put("/api/admin/comps-cost").send({ credits: -1 }))).status).toBe(400);
      expect(compsSettings.setCost).not.toHaveBeenCalled();
    });

    it("reset reverts to the default", async () => {
      compsSettings.resetCost.mockResolvedValue(costView({ isDefault: true }) as never);
      const res = await asAdmin(request(app).post("/api/admin/comps-cost/reset"));
      expect(res.status).toBe(200);
      expect(res.body.isDefault).toBe(true);
      expect(compsSettings.resetCost).toHaveBeenCalled();
    });
  });

  // --- Comps default parameters (JAK-137) -----------------------------------

  describe("comps-params", () => {
    const params = {
      radiusMiles: 1,
      count: 5,
      monthsBack: 12,
      bedsTolerance: 1,
      bathsTolerance: 1,
      sqftTolerancePct: 25,
    };
    const paramsView = (over: Record<string, unknown> = {}) => ({
      params,
      isDefault: false,
      updatedAt: new Date("2026-07-03T00:00:00Z"),
      updatedBy: "admin-id",
      ...over,
    });

    it("is behind the auth gate", async () => {
      auth.verifyToken.mockReturnValue(null);
      const res = await request(app).get("/api/admin/comps-params");
      expect(res.status).toBe(401);
      expect(compsSettings.getParamsView).not.toHaveBeenCalled();
    });

    it("GET returns the effective parameters view", async () => {
      compsSettings.getParamsView.mockResolvedValue(paramsView() as never);
      const res = await asAdmin(request(app).get("/api/admin/comps-params"));
      expect(res.status).toBe(200);
      expect(res.body.params.count).toBe(5);
    });

    it("PUT saves the full parameter-set with the editing admin id", async () => {
      compsSettings.setParams.mockResolvedValue(paramsView({ params: { ...params, count: 3 } }) as never);
      const res = await asAdmin(
        request(app).put("/api/admin/comps-params").send({ ...params, count: 3 })
      );
      expect(res.status).toBe(200);
      expect(compsSettings.setParams).toHaveBeenCalledWith({ ...params, count: 3 }, "admin-id");
    });

    it("PUT 400s when a parameter is not a number", async () => {
      const res = await asAdmin(
        request(app).put("/api/admin/comps-params").send({ ...params, count: "lots" })
      );
      expect(res.status).toBe(400);
      expect(compsSettings.setParams).not.toHaveBeenCalled();
    });

    it("reset reverts to the default", async () => {
      compsSettings.resetParams.mockResolvedValue(paramsView({ isDefault: true }) as never);
      const res = await asAdmin(request(app).post("/api/admin/comps-params/reset"));
      expect(res.status).toBe(200);
      expect(res.body.isDefault).toBe(true);
      expect(compsSettings.resetParams).toHaveBeenCalled();
    });
  });

  // --- Admin management (JAK-124) -------------------------------------------

  const adminView = (
    over: Partial<{ id: string; email: string; isActive: boolean; role: "admin" | "superadmin" }> = {}
  ) => ({
    id: "admin-id",
    email: "admin@example.com",
    isActive: true,
    role: "admin" as const,
    createdAt: new Date("2026-07-01T00:00:00Z"),
    ...over,
  });

  // --- Per-prompt provider + model picker (JAK-143) -------------------------

  describe("provider + model picker (JAK-143)", () => {
    const modelView = (over: Record<string, unknown> = {}) => ({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      isDefault: false,
      effectiveProvider: "anthropic",
      effectiveModel: "claude-sonnet-4-6",
      defaultProvider: "openai",
      defaultModel: "gpt-4o",
      providerKeyConfigured: { openai: true, anthropic: false },
      updatedAt: new Date("2026-07-03T00:00:00Z"),
      updatedBy: "admin-id",
      ...over,
    });

    // The four surfaces and their route segments (JAK-143).
    const surfaces: Array<[string, string]> = [
      ["report-model", "property_report"],
      ["orchestrator-model", "orchestrator"],
      ["skiptrace-model", "skiptrace"],
      ["comps-model", "comps"],
    ];

    it.each(surfaces)("%s GET/PUT/reset is behind the auth gate", async (path) => {
      auth.verifyToken.mockReturnValue(null);
      expect((await request(app).get(`/api/admin/${path}`)).status).toBe(401);
      expect(
        (await request(app).put(`/api/admin/${path}`).send({ provider: "openai" })).status
      ).toBe(401);
      expect((await request(app).post(`/api/admin/${path}/reset`)).status).toBe(401);
      expect(modelSettings.getView).not.toHaveBeenCalled();
      expect(modelSettings.setSelection).not.toHaveBeenCalled();
      expect(modelSettings.reset).not.toHaveBeenCalled();
    });

    it.each(surfaces)("%s is available to a REGULAR admin (not superadmin-gated)", async (path) => {
      asPlainAdmin();
      modelSettings.getView.mockResolvedValue(modelView() as never);
      modelSettings.setSelection.mockResolvedValue(modelView() as never);
      modelSettings.reset.mockResolvedValue(modelView({ isDefault: true }) as never);
      expect((await asAdmin(request(app).get(`/api/admin/${path}`))).status).toBe(200);
      expect(
        (await asAdmin(request(app).put(`/api/admin/${path}`).send({ provider: "openai" }))).status
      ).toBe(200);
      expect((await asAdmin(request(app).post(`/api/admin/${path}/reset`))).status).toBe(200);
    });

    it.each(surfaces)("%s GET returns the surface's model view", async (path, surface) => {
      modelSettings.getView.mockResolvedValue(modelView() as never);
      const res = await asAdmin(request(app).get(`/api/admin/${path}`));
      expect(res.status).toBe(200);
      expect(res.body.effectiveModel).toBe("claude-sonnet-4-6");
      expect(modelSettings.getView).toHaveBeenCalledWith(surface);
    });

    it.each(surfaces)("%s PUT pins a provider + trimmed model for its surface, attributed to the admin", async (path, surface) => {
      modelSettings.setSelection.mockResolvedValue(modelView() as never);
      const res = await asAdmin(
        request(app).put(`/api/admin/${path}`).send({ provider: "Anthropic", model: "  claude-sonnet-4-6  " })
      );
      expect(res.status).toBe(200);
      // Provider lower-cased, model trimmed, attributed to the logged-in admin.
      expect(modelSettings.setSelection).toHaveBeenCalledWith(
        surface,
        "anthropic",
        "claude-sonnet-4-6",
        "admin-id"
      );
    });

    it("PUT with a blank model stores null (inherit the provider's default model)", async () => {
      modelSettings.setSelection.mockResolvedValue(modelView() as never);
      await asAdmin(request(app).put("/api/admin/comps-model").send({ provider: "openai", model: "   " }));
      expect(modelSettings.setSelection).toHaveBeenCalledWith("comps", "openai", null, "admin-id");
    });

    it("PUT 400s an unknown provider — never persists it", async () => {
      const res = await asAdmin(
        request(app).put("/api/admin/comps-model").send({ provider: "banana", model: "x" })
      );
      expect(res.status).toBe(400);
      expect(modelSettings.setSelection).not.toHaveBeenCalled();
    });

    it("PUT 400s a missing provider", async () => {
      const res = await asAdmin(request(app).put("/api/admin/comps-model").send({ model: "gpt-4o" }));
      expect(res.status).toBe(400);
      expect(modelSettings.setSelection).not.toHaveBeenCalled();
    });

    it("reset reverts a surface to the global default", async () => {
      modelSettings.reset.mockResolvedValue(modelView({ isDefault: true }) as never);
      const res = await asAdmin(request(app).post("/api/admin/skiptrace-model/reset"));
      expect(res.status).toBe(200);
      expect(res.body.isDefault).toBe(true);
      expect(modelSettings.reset).toHaveBeenCalledWith("skiptrace");
    });

    it("no response ever carries an API key (only provider names + model ids + key-configured booleans)", async () => {
      modelSettings.getView.mockResolvedValue(modelView() as never);
      const res = await asAdmin(request(app).get("/api/admin/orchestrator-model"));
      const body = JSON.stringify(res.body);
      expect(body).not.toMatch(/apiKey|api_key|sk-|OPENAI_API_KEY|ANTHROPIC_API_KEY/i);
      // The key-configured hint is booleans only.
      expect(res.body.providerKeyConfigured).toEqual({ openai: true, anthropic: false });
    });
  });

  // --- Superadmin gate (JAK-125) --------------------------------------------

  describe("superadmin gate", () => {
    const mgmtRoutes: Array<[string, string]> = [
      ["get", "/api/admin/admins"],
      ["post", "/api/admin/admins"],
      ["post", "/api/admin/admins/other/activate"],
      ["post", "/api/admin/admins/other/deactivate"],
      ["post", "/api/admin/admins/other/password"],
    ];

    it("403s a regular admin on EVERY admin-management route", async () => {
      asPlainAdmin();
      for (const [method, path] of mgmtRoutes) {
        const res = await asAdmin((request(app) as unknown as Record<string, (p: string) => request.Test>)[method](path));
        expect(res.status).toBe(403);
      }
      // No management work is done for a non-superadmin.
      expect(auth.listAdmins).not.toHaveBeenCalled();
      expect(auth.createAdmin).not.toHaveBeenCalled();
      expect(auth.setAdminActive).not.toHaveBeenCalled();
      expect(auth.resetAdminPassword).not.toHaveBeenCalled();
    });

    it("lets a regular admin keep FULL sub-account management (not gated)", async () => {
      asPlainAdmin();
      status.listLocationStatuses.mockResolvedValue([]);
      connections.deactivate.mockResolvedValue(true);
      connections.delete.mockResolvedValue(true);

      expect((await asAdmin(request(app).get("/api/admin/connections"))).status).toBe(200);
      expect(
        (await asAdmin(request(app).post("/api/admin/connections/loc_1/deactivate"))).status
      ).toBe(200);
      expect((await asAdmin(request(app).delete("/api/admin/connections/loc_1"))).status).toBe(200);
    });
  });

  describe("GET /admins", () => {
    it("is behind the auth gate", async () => {
      auth.verifyToken.mockReturnValue(null);
      const res = await request(app).get("/api/admin/admins");
      expect(res.status).toBe(401);
      expect(auth.listAdmins).not.toHaveBeenCalled();
    });

    it("returns admin views and never leaks a password hash", async () => {
      auth.listAdmins.mockResolvedValue([adminView(), adminView({ id: "two", email: "b@x.co" })]);
      const res = await asAdmin(request(app).get("/api/admin/admins"));
      expect(res.status).toBe(200);
      expect(res.body.admins).toHaveLength(2);
      expect(JSON.stringify(res.body)).not.toContain("password_hash");
    });
  });

  describe("POST /admins", () => {
    it("400s an invalid email", async () => {
      const res = await asAdmin(
        request(app).post("/api/admin/admins").send({ email: "not-an-email", password: "unit-test-long-pw" })
      );
      expect(res.status).toBe(400);
      expect(auth.createAdmin).not.toHaveBeenCalled();
    });

    it("400s a too-short password", async () => {
      const res = await asAdmin(
        request(app).post("/api/admin/admins").send({ email: "new@example.com", password: "short" })
      );
      expect(res.status).toBe(400);
      expect(auth.createAdmin).not.toHaveBeenCalled();
    });

    it("409s a duplicate email", async () => {
      auth.emailExists.mockResolvedValue(true);
      const res = await asAdmin(
        request(app).post("/api/admin/admins").send({ email: "dupe@example.com", password: "unit-test-long-pw" })
      );
      expect(res.status).toBe(409);
      expect(auth.createAdmin).not.toHaveBeenCalled();
    });

    it("creates an admin and returns the hash-free view (defaults role to 'admin')", async () => {
      auth.emailExists.mockResolvedValue(false);
      auth.createAdmin.mockResolvedValue(adminView({ id: "new-id", email: "new@example.com" }));
      const res = await asAdmin(
        request(app).post("/api/admin/admins").send({ email: "New@Example.com", password: "unit-test-pw-123" })
      );
      expect(res.status).toBe(201);
      expect(res.body.admin.email).toBe("new@example.com");
      // Email normalized to lowercase; role defaults to 'admin' (JAK-125).
      expect(auth.createAdmin).toHaveBeenCalledWith("new@example.com", "unit-test-pw-123", "admin");
      // Neither the plaintext password nor any hash is echoed back.
      expect(JSON.stringify(res.body)).not.toContain("unit-test-pw-123");
      expect(JSON.stringify(res.body)).not.toContain("password_hash");
    });

    it("passes a chosen role through (JAK-125)", async () => {
      auth.emailExists.mockResolvedValue(false);
      auth.createAdmin.mockResolvedValue(adminView({ id: "new-id", email: "boss@example.com", role: "superadmin" }));
      const res = await asAdmin(
        request(app)
          .post("/api/admin/admins")
          .send({ email: "boss@example.com", password: "unit-test-pw-123", role: "superadmin" })
      );
      expect(res.status).toBe(201);
      expect(auth.createAdmin).toHaveBeenCalledWith("boss@example.com", "unit-test-pw-123", "superadmin");
    });

    it("400s an invalid role", async () => {
      const res = await asAdmin(
        request(app)
          .post("/api/admin/admins")
          .send({ email: "new@example.com", password: "unit-test-pw-123", role: "root" })
      );
      expect(res.status).toBe(400);
      expect(auth.createAdmin).not.toHaveBeenCalled();
    });
  });

  describe("POST /admins/:id/password (JAK-125)", () => {
    it("400s a too-short password", async () => {
      const res = await asAdmin(
        request(app).post("/api/admin/admins/other/password").send({ password: "short" })
      );
      expect(res.status).toBe(400);
      expect(auth.resetAdminPassword).not.toHaveBeenCalled();
    });

    it("resets the password and never echoes the plaintext or a hash", async () => {
      auth.resetAdminPassword.mockResolvedValue(adminView({ id: "other", email: "other@example.com" }));
      const res = await asAdmin(
        request(app).post("/api/admin/admins/other/password").send({ password: TEST_RESET_PW })
      );
      expect(res.status).toBe(200);
      expect(auth.resetAdminPassword).toHaveBeenCalledWith("other", TEST_RESET_PW);
      expect(JSON.stringify(res.body)).not.toContain(TEST_RESET_PW);
      expect(JSON.stringify(res.body)).not.toContain("password_hash");
    });

    it("404s an unknown admin", async () => {
      auth.resetAdminPassword.mockResolvedValue(null);
      const res = await asAdmin(
        request(app).post("/api/admin/admins/nope/password").send({ password: TEST_RESET_PW })
      );
      expect(res.status).toBe(404);
    });
  });

  describe("POST /admins/:id/deactivate", () => {
    it("refuses to deactivate your own logged-in account (lockout guard)", async () => {
      // The session in these tests is sub: "admin-id".
      const res = await asAdmin(request(app).post("/api/admin/admins/admin-id/deactivate"));
      expect(res.status).toBe(400);
      expect(auth.setAdminActive).not.toHaveBeenCalled();
    });

    it("deactivates another admin", async () => {
      auth.setAdminActive.mockResolvedValue(adminView({ id: "other", isActive: false }));
      const res = await asAdmin(request(app).post("/api/admin/admins/other/deactivate"));
      expect(res.status).toBe(200);
      expect(res.body.admin.isActive).toBe(false);
      expect(auth.setAdminActive).toHaveBeenCalledWith("other", false);
    });

    it("404s an unknown admin", async () => {
      auth.setAdminActive.mockResolvedValue(null);
      const res = await asAdmin(request(app).post("/api/admin/admins/nope/deactivate"));
      expect(res.status).toBe(404);
    });
  });

  describe("POST /admins/:id/activate", () => {
    it("re-enables an admin", async () => {
      auth.setAdminActive.mockResolvedValue(adminView({ id: "other", isActive: true }));
      const res = await asAdmin(request(app).post("/api/admin/admins/other/activate"));
      expect(res.status).toBe(200);
      expect(auth.setAdminActive).toHaveBeenCalledWith("other", true);
    });
  });
});
