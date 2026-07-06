import { NextFunction, Request, Response, Router } from "express";
import { inject, injectable } from "tsyringe";
import { GhlStatusService } from "../status/GhlStatusService";
import { AdminAuthService } from "./AdminAuthService";
import { AdminConnectionService } from "./AdminConnectionService";
import { AdminTextCustomerService, TextCustomerInput } from "./AdminTextCustomerService";
import { requireAdminAuth, requireSuperadmin } from "./requireAdminAuth";
import { AdminRole } from "./AdminTypes";
import { PropertyReportPromptService } from "../../services/PropertyReportPromptService";
import { OrchestratorPromptService } from "../../services/orchestrator/OrchestratorPromptService";
import { SkipTracePromptService } from "../../services/skiptrace/SkipTracePromptService";
import { SkipTraceSettingsService } from "../../services/skiptrace/SkipTraceSettingsService";
import { CompsPromptService } from "../../services/comps/CompsPromptService";
import { CompsSettingsService } from "../../services/comps/CompsSettingsService";
import { CompParams } from "../../services/comps/CompsTypes";
import { CreditSettingsService } from "../metering/CreditSettingsService";
import { CREDIT_TYPES, CreditType } from "../metering/CreditCosts";
import {
  LlmModelSettingsService,
  LlmSurface,
} from "../../services/llm/LlmModelSettingsService";
import { LLM_PROVIDERS, LlmProvider } from "../../services/llm/LlmSelection";

/**
 * The admin dashboard's data API (JAK-113) — CRUD over connected sub-accounts,
 * their status view, and manual credit grants. EVERY route is behind
 * {@link requireAdminAuth}; there is no unauthenticated path here.
 *
 *   GET    /connections                      — overview list (JAK-112 summary).
 *   POST   /connections                      — connect a sub-account (paste key).
 *   GET    /connections/:locationId          — full status detail (JAK-112).
 *   PUT    /connections/:locationId          — edit / rotate key.
 *   POST   /connections/:locationId/activate — reactivate.
 *   POST   /connections/:locationId/deactivate — inactive path (JAK-104/110).
 *   DELETE /connections/:locationId          — remove the connection.
 *   POST   /connections/:locationId/credits  — manual credit grant/adjustment.
 *
 *   GET    /text-customers                    — tier-1 texters + credit balances (JAK-129).
 *   POST   /text-customers/credits            — grant credits to a texter BY PHONE (JAK-129).
 *
 *   GET    /admins                — list admins (JAK-124), never any password hash.
 *   POST   /admins                — create an admin from { email, password, role? }.
 *   POST   /admins/:id/activate   — re-enable a disabled admin.
 *   POST   /admins/:id/deactivate — disable an admin (never your own account).
 *   POST   /admins/:id/password   — superadmin resets an admin's password (JAK-125).
 *
 * SUPERADMIN GATE (JAK-125): every /admins route is additionally behind
 * {@link requireSuperadmin} — a regular admin gets 403. The connection/status
 * routes are NOT gated, so a regular admin keeps full sub-account management.
 *
 * It REUSES the existing services — the read side is entirely JAK-112's
 * {@link GhlStatusService} (already credential-free), and the write side is the
 * thin {@link AdminConnectionService} adapter over JAK-102/104/109/110. No
 * business logic or query is reimplemented here. Responses never carry a
 * decrypted API key (create/edit return the masked view).
 */
@injectable()
export class AdminResource {
  public readonly router: Router;

  constructor(
    @inject(AdminAuthService) private readonly auth: AdminAuthService,
    @inject(AdminConnectionService) private readonly connections: AdminConnectionService,
    @inject(AdminTextCustomerService) private readonly textCustomers: AdminTextCustomerService,
    @inject(GhlStatusService) private readonly status: GhlStatusService,
    @inject(PropertyReportPromptService) private readonly reportPrompt: PropertyReportPromptService,
    @inject(OrchestratorPromptService) private readonly orchestratorPrompt: OrchestratorPromptService,
    @inject(SkipTracePromptService) private readonly skipTracePrompt: SkipTracePromptService,
    @inject(SkipTraceSettingsService) private readonly skipTraceSettings: SkipTraceSettingsService,
    @inject(CompsPromptService) private readonly compsPrompt: CompsPromptService,
    @inject(CompsSettingsService) private readonly compsSettings: CompsSettingsService,
    @inject(CreditSettingsService) private readonly creditSettings: CreditSettingsService,
    @inject(LlmModelSettingsService) private readonly modelSettings: LlmModelSettingsService
  ) {
    this.router = Router();
    this.configureRoutes();
  }

  private configureRoutes(): void {
    // Gate the whole surface — nothing here is reachable without a valid session.
    this.router.use(requireAdminAuth(this.auth));

    this.router.get("/connections", this.list.bind(this));
    this.router.post("/connections", this.create.bind(this));
    this.router.get("/connections/:locationId", this.detail.bind(this));
    this.router.put("/connections/:locationId", this.update.bind(this));
    this.router.post("/connections/:locationId/activate", this.activate.bind(this));
    this.router.post("/connections/:locationId/deactivate", this.deactivate.bind(this));
    this.router.delete("/connections/:locationId", this.remove.bind(this));
    this.router.post("/connections/:locationId/credits", this.grantCredits.bind(this));

    // Tier-1 text-Jake customers (JAK-129): list texters + their credit balances,
    // and grant credits to one BY PHONE — a different account key than a
    // connection's locationId, so a gateway texter can finally be topped up.
    this.router.get("/text-customers", this.listTextCustomers.bind(this));
    // Create / edit a texter's profile (JAK-146): name + optional email, keyed by
    // the required phone. On save each also syncs the texter to the Jake GHL
    // sub-account and sets "text Jake" = approved (JAK-147). Distinct from the
    // /credits grant below.
    this.router.post("/text-customers", this.createTextCustomer.bind(this));
    // Prefill the form from an existing Jake-sub-account contact (JAK-147). A
    // literal path, so it never collides with the PUT /:id edit route below.
    this.router.post("/text-customers/find-contact", this.findTextCustomerContact.bind(this));
    this.router.put("/text-customers/:id", this.updateTextCustomer.bind(this));
    this.router.post("/text-customers/credits", this.grantTextCustomerCredits.bind(this));
    // Two-level hold controls (JAK-148). Sub-paths under :id, so no collision with
    // the literal /credits or /find-contact routes or the PUT /:id edit above.
    //   hold       — SOFT: GHL keeps forwarding; Jake replies "on hold", no charge.
    //   deactivate — HARD: flip "text Jake" unapproved so GHL stops forwarding.
    //   reactivate — back to active: re-approve "text Jake"; normal processing.
    // NONE of these touch credits.
    this.router.post("/text-customers/:id/hold", this.holdTextCustomer.bind(this));
    this.router.post("/text-customers/:id/deactivate", this.deactivateTextCustomer.bind(this));
    this.router.post("/text-customers/:id/reactivate", this.reactivateTextCustomer.bind(this));

    // AI prompt — the admin-editable STYLE/FORMAT prompt for the JAK-130 property
    // report (JAK-131). Available to ANY logged-in admin (requireAuth only — NOT
    // behind requireSuperadmin), so a regular operator can tune the report's look.
    // The HARD guardrails (no emojis / only-provided-values / GoTextJake.com
    // footer) are enforced in the writer and are NOT editable here.
    this.router.get("/report-prompt", this.getReportPrompt.bind(this));
    this.router.put("/report-prompt", this.updateReportPrompt.bind(this));
    this.router.post("/report-prompt/reset", this.resetReportPrompt.bind(this));

    // AI prompt — the admin-editable STYLE/CLASSIFICATION prompt for the JAK-135
    // orchestrator/router (same editable pattern as JAK-131). Available to ANY
    // logged-in admin (requireAuth only). The HARD routing rules (fixed intent
    // set, JSON-only output, never-invent-an-address) are appended by the router
    // client and are NOT editable here.
    this.router.get("/orchestrator-prompt", this.getOrchestratorPrompt.bind(this));
    this.router.put("/orchestrator-prompt", this.updateOrchestratorPrompt.bind(this));
    this.router.post("/orchestrator-prompt/reset", this.resetOrchestratorPrompt.bind(this));

    // Skip-trace specialist (JAK-136): the admin-editable STYLE prompt AND the
    // admin-editable credit cost, both the SAME editable pattern as above.
    // Available to ANY logged-in admin (requireAuth only). The HARD guardrails
    // (no emojis / only-provided-values / GoTextJake.com footer) are enforced by
    // the specialist writer and are NOT editable here.
    this.router.get("/skiptrace-prompt", this.getSkipTracePrompt.bind(this));
    this.router.put("/skiptrace-prompt", this.updateSkipTracePrompt.bind(this));
    this.router.post("/skiptrace-prompt/reset", this.resetSkipTracePrompt.bind(this));
    this.router.get("/skiptrace-cost", this.getSkipTraceCost.bind(this));
    this.router.put("/skiptrace-cost", this.updateSkipTraceCost.bind(this));
    this.router.post("/skiptrace-cost/reset", this.resetSkipTraceCost.bind(this));

    // Comps specialist (JAK-137): the admin-editable STYLE prompt, the
    // admin-editable credit cost, AND the admin-editable DEFAULT comp parameters
    // (radius, count, timeframe, bed/bath/sqft tolerance) — all the SAME editable
    // pattern as above. Available to ANY logged-in admin (requireAuth only). The
    // HARD guardrails (no emojis / only-provided-values / GoTextJake.com footer) are
    // enforced by the specialist writer and are NOT editable here.
    this.router.get("/comps-prompt", this.getCompsPrompt.bind(this));
    this.router.put("/comps-prompt", this.updateCompsPrompt.bind(this));
    this.router.post("/comps-prompt/reset", this.resetCompsPrompt.bind(this));
    this.router.get("/comps-cost", this.getCompsCost.bind(this));
    this.router.put("/comps-cost", this.updateCompsCost.bind(this));
    this.router.post("/comps-cost/reset", this.resetCompsCost.bind(this));
    this.router.get("/comps-params", this.getCompsParams.bind(this));
    this.router.put("/comps-params", this.updateCompsParams.bind(this));
    this.router.post("/comps-params/reset", this.resetCompsParams.bind(this));

    // Per-feature CREDIT settings (JAK-161) — the backend the JAK-162 admin UI
    // reads/writes: the NEW-CUSTOMER default grants (report / skiptrace / comps)
    // and the per-feature OUT-OF-CREDITS messages, both the SAME editable
    // app_settings pattern as the costs above. Available to ANY logged-in admin
    // (requireAuth only). No secret is exposed; the canonical JAK-158 footer is
    // appended by the sender and is NOT editable here.
    this.router.get("/credit-defaults", this.getCreditDefaults.bind(this));
    this.router.put("/credit-defaults", this.updateCreditDefault.bind(this));
    this.router.post("/credit-defaults/reset", this.resetCreditDefault.bind(this));
    this.router.get("/out-of-credits-messages", this.getOutOfCreditsMessages.bind(this));
    this.router.put("/out-of-credits-messages", this.updateOutOfCreditsMessage.bind(this));
    this.router.post("/out-of-credits-messages/reset", this.resetOutOfCreditsMessage.bind(this));

    // Per-prompt PROVIDER + MODEL picker (JAK-143). Each of the four editable-prompt
    // surfaces (router, skip-trace, comps, property report) can OPTIONALLY pin its
    // own provider (OpenAI / Anthropic) + model; unset falls back to the global
    // Doppler default (LLM_PROVIDER / OPENAI_MODEL). Same editable pattern +
    // requireAuth-only gate as the prompts above. NO api-key entry anywhere — the
    // routes select a provider+model only; keys stay Doppler secrets.
    this.modelRoutes("report-model", "property_report");
    this.modelRoutes("orchestrator-model", "orchestrator");
    this.modelRoutes("skiptrace-model", "skiptrace");
    this.modelRoutes("comps-model", "comps");

    // Admin management (JAK-124, restricted in JAK-125): ONLY a superadmin may
    // manage other admins. requireSuperadmin runs after the router-level
    // requireAdminAuth above, so req.admin is already populated. A regular admin
    // hitting any of these gets 403; connections/status above stay open to them.
    const superadmin = requireSuperadmin();
    this.router.get("/admins", superadmin, this.listAdmins.bind(this));
    this.router.post("/admins", superadmin, this.createAdmin.bind(this));
    this.router.post("/admins/:id/activate", superadmin, this.activateAdmin.bind(this));
    this.router.post("/admins/:id/deactivate", superadmin, this.deactivateAdmin.bind(this));
    this.router.post("/admins/:id/password", superadmin, this.resetAdminPassword.bind(this));
  }

  // --- Admin management (JAK-124) ------------------------------------------

  private async listAdmins(_req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      // toAdminView drops password_hash — the list NEVER carries a hash.
      const admins = await this.auth.listAdmins();
      return res.status(200).json({ admins });
    } catch (err) {
      return next(err);
    }
  }

  private async createAdmin(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const email = str(req.body?.email).toLowerCase();
      // Password is intentionally NOT trimmed or logged — it's read once, hashed
      // by AdminAuthService, then discarded.
      const password = typeof req.body?.password === "string" ? req.body.password : "";

      if (!EMAIL_RE.test(email)) {
        return res.status(400).json({ error: "A valid email is required" });
      }
      if (password.length < MIN_PASSWORD_LENGTH) {
        return res
          .status(400)
          .json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
      }
      // Optional role (JAK-125). A superadmin — the only caller past the guard —
      // may create either role; anything else is a 400. Default is 'admin'.
      const role = req.body?.role;
      if (role !== undefined && role !== "admin" && role !== "superadmin") {
        return res.status(400).json({ error: "role must be 'admin' or 'superadmin'" });
      }
      if (await this.auth.emailExists(email)) {
        return res.status(409).json({ error: "An admin with that email already exists" });
      }

      const admin = await this.auth.createAdmin(email, password, (role as AdminRole) ?? "admin");
      return res.status(201).json({ admin });
    } catch (err) {
      // Unique-violation backstop for a race between the pre-check and insert.
      if (err && typeof err === "object" && (err as { code?: string }).code === "23505") {
        return res.status(409).json({ error: "An admin with that email already exists" });
      }
      return next(err);
    }
  }

  private async activateAdmin(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const admin = await this.auth.setAdminActive(str(req.params.id), true);
      if (!admin) return res.status(404).json({ error: "unknown admin" });
      return res.status(200).json({ admin });
    } catch (err) {
      return next(err);
    }
  }

  private async deactivateAdmin(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const id = str(req.params.id);
      // Lockout guard: an admin can never disable their own logged-in account —
      // that could lock the last operator out of the dashboard.
      if (id === req.admin?.sub) {
        return res.status(400).json({ error: "You can't deactivate your own account" });
      }
      const admin = await this.auth.setAdminActive(id, false);
      if (!admin) return res.status(404).json({ error: "unknown admin" });
      return res.status(200).json({ admin });
    } catch (err) {
      return next(err);
    }
  }

  private async resetAdminPassword(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const id = str(req.params.id);
      // Password is intentionally NOT trimmed or logged — read once, hashed by
      // AdminAuthService, then discarded. No email/reset-link/token: a superadmin
      // types the new password and hands it over (same philosophy as create).
      const password = typeof req.body?.password === "string" ? req.body.password : "";
      if (password.length < MIN_PASSWORD_LENGTH) {
        return res
          .status(400)
          .json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
      }

      const admin = await this.auth.resetAdminPassword(id, password);
      if (!admin) return res.status(404).json({ error: "unknown admin" });
      return res.status(200).json({ admin });
    } catch (err) {
      return next(err);
    }
  }

  private async list(_req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const locations = await this.status.listLocationStatuses();
      return res.status(200).json({ locations });
    } catch (err) {
      return next(err);
    }
  }

  private async create(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const locationId = str(req.body?.locationId);
      const apiKey = typeof req.body?.apiKey === "string" ? req.body.apiKey.trim() : "";
      const baseUrl = str(req.body?.baseUrl);
      const phoneNumbers = phoneList(req.body?.phoneNumbers);

      if (!locationId || !apiKey || !baseUrl) {
        return res
          .status(400)
          .json({ error: "locationId, apiKey and baseUrl are required" });
      }

      const view = await this.connections.create({ locationId, apiKey, baseUrl, phoneNumbers });
      return res.status(201).json({ connection: view });
    } catch (err) {
      return this.handleWriteError(err, res, next);
    }
  }

  private async detail(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const locationId = str(req.params.locationId);
      if (!locationId) return res.status(400).json({ error: "missing location id" });
      const detail = await this.status.getLocationStatus(locationId);
      if (!detail) return res.status(404).json({ error: "unknown location" });
      return res.status(200).json(detail);
    } catch (err) {
      return next(err);
    }
  }

  private async update(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const locationId = str(req.params.locationId);
      if (!locationId) return res.status(400).json({ error: "missing location id" });

      const apiKeyRaw = req.body?.apiKey;
      // A provided-but-empty apiKey is a client mistake, not "keep the key" —
      // undefined means keep; a blank string is rejected.
      if (apiKeyRaw !== undefined && String(apiKeyRaw).trim() === "") {
        return res.status(400).json({ error: "apiKey cannot be blank" });
      }

      const view = await this.connections.update(locationId, {
        apiKey: apiKeyRaw !== undefined ? String(apiKeyRaw).trim() : undefined,
        baseUrl: req.body?.baseUrl !== undefined ? str(req.body.baseUrl) : undefined,
        phoneNumbers:
          req.body?.phoneNumbers !== undefined ? phoneList(req.body.phoneNumbers) : undefined,
      });
      if (!view) return res.status(404).json({ error: "unknown location" });
      return res.status(200).json({ connection: view });
    } catch (err) {
      return next(err);
    }
  }

  private async activate(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const locationId = str(req.params.locationId);
      const view = await this.connections.activate(locationId);
      if (!view) return res.status(404).json({ error: "unknown location" });
      return res.status(200).json({ connection: view });
    } catch (err) {
      return next(err);
    }
  }

  private async deactivate(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const locationId = str(req.params.locationId);
      const ok = await this.connections.deactivate(locationId);
      if (!ok) return res.status(404).json({ error: "unknown location" });
      return res.status(200).json({ ok: true });
    } catch (err) {
      return next(err);
    }
  }

  private async remove(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const locationId = str(req.params.locationId);
      const ok = await this.connections.delete(locationId);
      if (!ok) return res.status(404).json({ error: "unknown location" });
      return res.status(200).json({ ok: true });
    } catch (err) {
      return next(err);
    }
  }

  private async grantCredits(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const locationId = str(req.params.locationId);
      const amount = Number(req.body?.amount);
      if (!Number.isInteger(amount) || amount === 0) {
        return res.status(400).json({ error: "amount must be a non-zero integer" });
      }
      const reason = req.body?.reason === "adjustment" ? "adjustment" : "manual_grant";
      const entry = await this.connections.grantCredits(locationId, amount, reason);
      if (!entry) return res.status(404).json({ error: "unknown location" });
      return res.status(200).json({ balance: entry.balance_after, entry });
    } catch (err) {
      return next(err);
    }
  }

  // --- Tier-1 text-Jake customers (JAK-129) --------------------------------

  private async listTextCustomers(_req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const customers = await this.textCustomers.list();
      return res.status(200).json({ customers });
    } catch (err) {
      return next(err);
    }
  }

  /**
   * Grant credits to a tier-1 texter BY PHONE (JAK-129). Same validation as the
   * connection grant — a non-zero integer, negative allowed for an adjustment —
   * but the account key is the CUSTOMER's credit-account id (resolved from the
   * phone), never a connection locationId. The customer is created on first
   * grant, so a number that hasn't texted in yet can still be credited.
   */
  private async grantTextCustomerCredits(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const phone = str(req.body?.phone);
      const amount = Number(req.body?.amount);
      if (!phone) {
        return res.status(400).json({ error: "phone is required" });
      }
      if (!Number.isInteger(amount) || amount === 0) {
        return res.status(400).json({ error: "amount must be a non-zero integer" });
      }
      const reason = req.body?.reason === "adjustment" ? "adjustment" : "manual_grant";
      const result = await this.textCustomers.grantCredits(phone, amount, reason);
      return res.status(200).json({
        balance: result.balance,
        customer: result.customer,
        entry: result.entry,
      });
    } catch (err) {
      return next(err);
    }
  }

  /**
   * Create a text customer's profile (JAK-146): first/last name + an OPTIONAL
   * email, keyed by the REQUIRED phone. A blank email is allowed (saved as null);
   * a non-blank email must look like one. A duplicate phone is a 409 (that number
   * is already a text customer), not a 500.
   */
  private async createTextCustomer(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const parsed = parseTextCustomerBody(req);
      if ("error" in parsed) {
        return res.status(400).json({ error: parsed.error });
      }
      // The result carries both the saved customer and the GHL sync outcome
      // (JAK-147) — the UI surfaces the sync message inline.
      const { customer, sync } = await this.textCustomers.create(parsed.value);
      return res.status(201).json({ customer, sync });
    } catch (err) {
      return this.handleTextCustomerWriteError(err, res, next);
    }
  }

  /**
   * Look up an existing Jake-sub-account contact by phone (JAK-147) so the admin
   * form can prefill name/email. A READ only — creating/approving happens on
   * save. Never leaks GHL internals: returns a friendly found/not-found result.
   */
  private async findTextCustomerContact(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const phone = str(req.body?.phone);
      if (!phone) {
        return res.status(400).json({ error: "phone is required" });
      }
      const result = await this.textCustomers.findContact(phone);
      return res.status(200).json(result);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * Edit a text customer's phone + profile by id (JAK-146). Same validation as
   * create — phone required, email optional-but-valid. 404 if no live customer
   * has that id; 409 if the new phone collides with another customer.
   */
  private async updateTextCustomer(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const id = str(req.params.id);
      if (!id) {
        return res.status(400).json({ error: "missing customer id" });
      }
      const parsed = parseTextCustomerBody(req);
      if ("error" in parsed) {
        return res.status(400).json({ error: parsed.error });
      }
      const result = await this.textCustomers.update(id, parsed.value);
      if (!result) {
        return res.status(404).json({ error: "unknown customer" });
      }
      return res.status(200).json({ customer: result.customer, sync: result.sync });
    } catch (err) {
      return this.handleTextCustomerWriteError(err, res, next);
    }
  }

  /**
   * Put a text customer on SOFT hold (JAK-148). GHL keeps forwarding their texts
   * (the "text Jake" field stays approved); Jake intercepts inbound server-side
   * and replies a hold notice without processing or charging. No GHL write, no
   * credit change. 404 if no live customer has that id.
   */
  private async holdTextCustomer(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    return this.changeTextCustomerStatus(req, res, next, "on_hold");
  }

  /**
   * HARD-deactivate a text customer (JAK-148). Flips the GHL "text Jake" field to
   * unapproved via the JAK-147 sync so GHL STOPS forwarding their texts entirely;
   * a backstop still refuses to process/charge if one slips through. No credit
   * change. 404 if no live customer has that id.
   */
  private async deactivateTextCustomer(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    return this.changeTextCustomerStatus(req, res, next, "deactivated");
  }

  /**
   * Reactivate a text customer (JAK-148) from either hold state. Re-approves the
   * GHL "text Jake" field so GHL forwards again and clears the hold so normal
   * processing resumes. No credit change. 404 if no live customer has that id.
   */
  private async reactivateTextCustomer(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    return this.changeTextCustomerStatus(req, res, next, "active");
  }

  /** Shared body for the three hold transitions — delegates to the service. */
  private async changeTextCustomerStatus(
    req: Request,
    res: Response,
    next: NextFunction,
    status: "on_hold" | "deactivated" | "active"
  ): Promise<Response | void> {
    try {
      const id = str(req.params.id);
      if (!id) {
        return res.status(400).json({ error: "missing customer id" });
      }
      const result = await this.textCustomers.changeStatus(id, status);
      if (!result) {
        return res.status(404).json({ error: "unknown customer" });
      }
      return res.status(200).json({ customer: result.customer, sync: result.sync });
    } catch (err) {
      return next(err);
    }
  }

  /** A duplicate phone (unique violation, 23505) is a client 409, not a 500. */
  private handleTextCustomerWriteError(err: unknown, res: Response, next: NextFunction): Response | void {
    if (err && typeof err === "object" && (err as { code?: string }).code === "23505") {
      return res.status(409).json({ error: "That phone is already a text customer" });
    }
    return next(err);
  }

  // --- AI prompt (JAK-131) --------------------------------------------------

  /** Return the effective editable STYLE prompt + whether it is still the default. */
  private async getReportPrompt(_req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const view = await this.reportPrompt.getView();
      return res.status(200).json(view);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * Save an admin-edited STYLE prompt. The body's `prompt` is the style/format
   * text ONLY — the hard guardrails are enforced by the writer regardless, so
   * there is nothing dangerous to reject here beyond an empty value. Records the
   * editing admin (req.admin.sub) for the audit stamp.
   */
  private async updateReportPrompt(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const prompt = typeof req.body?.prompt === "string" ? req.body.prompt.trim() : "";
      if (!prompt) {
        return res.status(400).json({ error: "prompt is required" });
      }
      if (prompt.length > MAX_PROMPT_LENGTH) {
        return res
          .status(400)
          .json({ error: `prompt must be at most ${MAX_PROMPT_LENGTH} characters` });
      }
      const view = await this.reportPrompt.setPrompt(prompt, req.admin?.sub ?? null);
      return res.status(200).json(view);
    } catch (err) {
      return next(err);
    }
  }

  /** Revert the STYLE prompt to the code default (clears the stored value). */
  private async resetReportPrompt(_req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const view = await this.reportPrompt.resetPrompt();
      return res.status(200).json(view);
    } catch (err) {
      return next(err);
    }
  }

  // --- Orchestrator/router prompt (JAK-135) ---------------------------------

  /** Return the effective editable router prompt + whether it is still the default. */
  private async getOrchestratorPrompt(_req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const view = await this.orchestratorPrompt.getView();
      return res.status(200).json(view);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * Save an admin-edited router prompt. The body's `prompt` is the
   * style/classification text ONLY — the hard routing rules (intent set,
   * JSON-only output, never-invent-an-address) are appended by the router client
   * regardless, so there is nothing dangerous to reject beyond an empty value.
   * Records the editing admin (req.admin.sub) for the audit stamp.
   */
  private async updateOrchestratorPrompt(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const prompt = typeof req.body?.prompt === "string" ? req.body.prompt.trim() : "";
      if (!prompt) {
        return res.status(400).json({ error: "prompt is required" });
      }
      if (prompt.length > MAX_PROMPT_LENGTH) {
        return res
          .status(400)
          .json({ error: `prompt must be at most ${MAX_PROMPT_LENGTH} characters` });
      }
      const view = await this.orchestratorPrompt.setPrompt(prompt, req.admin?.sub ?? null);
      return res.status(200).json(view);
    } catch (err) {
      return next(err);
    }
  }

  /** Revert the router prompt to the code default (clears the stored value). */
  private async resetOrchestratorPrompt(_req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const view = await this.orchestratorPrompt.resetPrompt();
      return res.status(200).json(view);
    } catch (err) {
      return next(err);
    }
  }

  // --- Skip-trace specialist prompt + cost (JAK-136) ------------------------

  /** Return the effective editable skip-trace prompt + whether it is still the default. */
  private async getSkipTracePrompt(_req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const view = await this.skipTracePrompt.getView();
      return res.status(200).json(view);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * Save an admin-edited skip-trace STYLE prompt. The body's `prompt` is the style
   * text ONLY — the hard guardrails (no emojis, only-provided-values, footer) are
   * enforced by the specialist writer regardless, so there is nothing dangerous to
   * reject beyond an empty value. Records the editing admin for the audit stamp.
   */
  private async updateSkipTracePrompt(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const prompt = typeof req.body?.prompt === "string" ? req.body.prompt.trim() : "";
      if (!prompt) {
        return res.status(400).json({ error: "prompt is required" });
      }
      if (prompt.length > MAX_PROMPT_LENGTH) {
        return res.status(400).json({ error: `prompt must be at most ${MAX_PROMPT_LENGTH} characters` });
      }
      const view = await this.skipTracePrompt.setPrompt(prompt, req.admin?.sub ?? null);
      return res.status(200).json(view);
    } catch (err) {
      return next(err);
    }
  }

  /** Revert the skip-trace prompt to the code default (clears the stored value). */
  private async resetSkipTracePrompt(_req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const view = await this.skipTracePrompt.resetPrompt();
      return res.status(200).json(view);
    } catch (err) {
      return next(err);
    }
  }

  /** Return the effective skip-trace credit cost + whether it is still the default. */
  private async getSkipTraceCost(_req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const view = await this.skipTraceSettings.getView();
      return res.status(200).json(view);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * Save an admin-edited skip-trace credit cost. `credits` must be a positive
   * integer — a skip trace is a PAID call, so it can never be set to 0/free.
   * Records the editing admin for the audit stamp.
   */
  private async updateSkipTraceCost(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const credits = Number(req.body?.credits);
      if (!Number.isInteger(credits) || credits <= 0) {
        return res.status(400).json({ error: "credits must be a positive integer" });
      }
      const view = await this.skipTraceSettings.setCost(credits, req.admin?.sub ?? null);
      return res.status(200).json(view);
    } catch (err) {
      return next(err);
    }
  }

  /** Revert the skip-trace credit cost to the code default (clears the stored value). */
  private async resetSkipTraceCost(_req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const view = await this.skipTraceSettings.resetCost();
      return res.status(200).json(view);
    } catch (err) {
      return next(err);
    }
  }

  // --- Comps specialist prompt + cost + parameters (JAK-137) ----------------

  /** Return the effective editable comps prompt + whether it is still the default. */
  private async getCompsPrompt(_req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const view = await this.compsPrompt.getView();
      return res.status(200).json(view);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * Save an admin-edited comps STYLE prompt. The body's `prompt` is the style text
   * ONLY — the hard guardrails (no emojis, only-provided-values, footer) are enforced
   * by the specialist writer regardless, so there is nothing dangerous to reject
   * beyond an empty value. Records the editing admin for the audit stamp.
   */
  private async updateCompsPrompt(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const prompt = typeof req.body?.prompt === "string" ? req.body.prompt.trim() : "";
      if (!prompt) {
        return res.status(400).json({ error: "prompt is required" });
      }
      if (prompt.length > MAX_PROMPT_LENGTH) {
        return res.status(400).json({ error: `prompt must be at most ${MAX_PROMPT_LENGTH} characters` });
      }
      const view = await this.compsPrompt.setPrompt(prompt, req.admin?.sub ?? null);
      return res.status(200).json(view);
    } catch (err) {
      return next(err);
    }
  }

  /** Revert the comps prompt to the code default (clears the stored value). */
  private async resetCompsPrompt(_req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const view = await this.compsPrompt.resetPrompt();
      return res.status(200).json(view);
    } catch (err) {
      return next(err);
    }
  }

  /** Return the effective comps credit cost + whether it is still the default. */
  private async getCompsCost(_req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const view = await this.compsSettings.getCostView();
      return res.status(200).json(view);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * Save an admin-edited comps credit cost. `credits` must be a positive integer —
   * a comps pull is a PAID call, so it can never be set to 0/free. Records the
   * editing admin for the audit stamp.
   */
  private async updateCompsCost(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const credits = Number(req.body?.credits);
      if (!Number.isInteger(credits) || credits <= 0) {
        return res.status(400).json({ error: "credits must be a positive integer" });
      }
      const view = await this.compsSettings.setCost(credits, req.admin?.sub ?? null);
      return res.status(200).json(view);
    } catch (err) {
      return next(err);
    }
  }

  /** Revert the comps credit cost to the code default (clears the stored value). */
  private async resetCompsCost(_req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const view = await this.compsSettings.resetCost();
      return res.status(200).json(view);
    } catch (err) {
      return next(err);
    }
  }

  /** Return the effective DEFAULT comp parameters + whether they are still the default. */
  private async getCompsParams(_req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const view = await this.compsSettings.getParamsView();
      return res.status(200).json(view);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * Save admin-edited DEFAULT comp parameters. Every field must be a finite number;
   * the service clamps them to sane bounds before persisting, so an out-of-range
   * entry is corrected rather than rejected. Records the editing admin for the stamp.
   */
  private async updateCompsParams(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const keys: (keyof CompParams)[] = [
        "radiusMiles",
        "count",
        "monthsBack",
        "bedsTolerance",
        "bathsTolerance",
        "sqftTolerancePct",
      ];
      const params = {} as CompParams;
      for (const key of keys) {
        const value = Number(req.body?.[key]);
        if (!Number.isFinite(value)) {
          return res.status(400).json({ error: `${key} must be a number` });
        }
        params[key] = value;
      }
      const view = await this.compsSettings.setParams(params, req.admin?.sub ?? null);
      return res.status(200).json(view);
    } catch (err) {
      return next(err);
    }
  }

  /** Revert the default comp parameters to the code default (clears the stored value). */
  private async resetCompsParams(_req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const view = await this.compsSettings.resetParams();
      return res.status(200).json(view);
    } catch (err) {
      return next(err);
    }
  }

  // --- Per-feature credit settings (JAK-161) --------------------------------

  /** Return all three new-customer default grants + whether each is still the default. */
  private async getCreditDefaults(_req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const defaults = await this.creditSettings.getDefaultViews();
      return res.status(200).json({ defaults });
    } catch (err) {
      return next(err);
    }
  }

  /**
   * Save one bucket's new-customer default grant. `type` is one of report /
   * skiptrace / comps; `credits` must be a NON-NEGATIVE integer (0 is valid — an
   * admin may want a paid feature to start empty). Records the editing admin.
   */
  private async updateCreditDefault(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const type = creditType(req.body?.type);
      if (!type) {
        return res.status(400).json({ error: "type must be one of report, skiptrace, comps" });
      }
      const credits = Number(req.body?.credits);
      if (!Number.isInteger(credits) || credits < 0) {
        return res.status(400).json({ error: "credits must be a non-negative integer" });
      }
      const view = await this.creditSettings.setDefaultGrant(type, credits, req.admin?.sub ?? null);
      return res.status(200).json(view);
    } catch (err) {
      return next(err);
    }
  }

  /** Revert one bucket's new-customer default grant to the code default. */
  private async resetCreditDefault(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const type = creditType(req.body?.type);
      if (!type) {
        return res.status(400).json({ error: "type must be one of report, skiptrace, comps" });
      }
      const view = await this.creditSettings.resetDefaultGrant(type);
      return res.status(200).json(view);
    } catch (err) {
      return next(err);
    }
  }

  /** Return all three out-of-credits messages + whether each is still the default. */
  private async getOutOfCreditsMessages(_req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const messages = await this.creditSettings.getMessageViews();
      return res.status(200).json({ messages });
    } catch (err) {
      return next(err);
    }
  }

  /**
   * Save one bucket's out-of-credits message. `type` is report / skiptrace /
   * comps; `message` must be non-empty. The canonical JAK-158 footer is appended
   * by the sender, so it is never part of the stored copy. Records the editing admin.
   */
  private async updateOutOfCreditsMessage(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const type = creditType(req.body?.type);
      if (!type) {
        return res.status(400).json({ error: "type must be one of report, skiptrace, comps" });
      }
      const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
      if (!message) {
        return res.status(400).json({ error: "message is required" });
      }
      if (message.length > MAX_PROMPT_LENGTH) {
        return res.status(400).json({ error: `message must be at most ${MAX_PROMPT_LENGTH} characters` });
      }
      const view = await this.creditSettings.setMessage(type, message, req.admin?.sub ?? null);
      return res.status(200).json(view);
    } catch (err) {
      return next(err);
    }
  }

  /** Revert one bucket's out-of-credits message to the code default. */
  private async resetOutOfCreditsMessage(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const type = creditType(req.body?.type);
      if (!type) {
        return res.status(400).json({ error: "type must be one of report, skiptrace, comps" });
      }
      const view = await this.creditSettings.resetMessage(type);
      return res.status(200).json(view);
    } catch (err) {
      return next(err);
    }
  }

  // --- Per-prompt provider + model picker (JAK-143) -------------------------

  /**
   * Register GET/PUT/reset for one surface's provider+model selection, mirroring
   * the prompt routes. `path` is the URL segment (e.g. "comps-model"); `surface`
   * is the {@link LlmSurface} it maps to. All three inherit the router-level
   * requireAdminAuth gate.
   */
  private modelRoutes(path: string, surface: LlmSurface): void {
    this.router.get(`/${path}`, (req, res, next) => this.getModel(surface, req, res, next));
    this.router.put(`/${path}`, (req, res, next) => this.updateModel(surface, req, res, next));
    this.router.post(`/${path}/reset`, (req, res, next) => this.resetModel(surface, req, res, next));
  }

  /** Return a surface's effective provider+model view (stored override + effective + global default). */
  private async getModel(
    surface: LlmSurface,
    _req: Request,
    res: Response,
    next: NextFunction
  ): Promise<Response | void> {
    try {
      const view = await this.modelSettings.getView(surface);
      return res.status(200).json(view);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * Pin a surface's provider (+ optional model). `provider` MUST be a known
   * provider (openai | anthropic); `model` is an OPTIONAL free-text model id (blank
   * → use the provider's default model). There is deliberately NO api-key field —
   * keys stay Doppler secrets; this only selects a provider+model. Records the
   * editing admin for the audit stamp.
   */
  private async updateModel(
    surface: LlmSurface,
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<Response | void> {
    try {
      const provider = typeof req.body?.provider === "string" ? req.body.provider.trim().toLowerCase() : "";
      if (!LLM_PROVIDERS.includes(provider as LlmProvider)) {
        return res.status(400).json({ error: `provider must be one of: ${LLM_PROVIDERS.join(", ")}` });
      }
      const modelRaw = req.body?.model;
      if (modelRaw !== undefined && modelRaw !== null && typeof modelRaw !== "string") {
        return res.status(400).json({ error: "model must be a string" });
      }
      const model = typeof modelRaw === "string" ? modelRaw.trim() : "";
      if (model.length > LlmModelSettingsService.MAX_MODEL_LENGTH) {
        return res
          .status(400)
          .json({ error: `model must be at most ${LlmModelSettingsService.MAX_MODEL_LENGTH} characters` });
      }
      const view = await this.modelSettings.setSelection(
        surface,
        provider as LlmProvider,
        model || null,
        req.admin?.sub ?? null
      );
      return res.status(200).json(view);
    } catch (err) {
      return next(err);
    }
  }

  /** Revert a surface's provider+model to the global default (clears the stored override). */
  private async resetModel(
    surface: LlmSurface,
    _req: Request,
    res: Response,
    next: NextFunction
  ): Promise<Response | void> {
    try {
      const view = await this.modelSettings.reset(surface);
      return res.status(200).json(view);
    } catch (err) {
      return next(err);
    }
  }

  /**
   * A duplicate location_id is a client error (that sub-account is already
   * connected), not a 500. Postgres unique-violation is code 23505.
   */
  private handleWriteError(err: unknown, res: Response, next: NextFunction): Response | void {
    if (err && typeof err === "object" && (err as { code?: string }).code === "23505") {
      return res.status(409).json({ error: "That location is already connected" });
    }
    return next(err);
  }
}

/** Minimum length for an admin-chosen password (JAK-124). */
const MIN_PASSWORD_LENGTH = 8;

/** Upper bound on the editable report STYLE prompt (JAK-131) — a sane guardrail. */
const MAX_PROMPT_LENGTH = 8000;

/** Pragmatic email shape check — a single `@` with non-empty, dot-bearing sides. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Coerce an unknown to a trimmed string ("" for non-strings). */
function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Validate a request's credit-bucket `type`, or null if it isn't one (JAK-161). */
function creditType(value: unknown): CreditType | null {
  return CREDIT_TYPES.includes(value as CreditType) ? (value as CreditType) : null;
}

/**
 * Validate + normalize a text-customer create/update body (JAK-146). Phone is
 * required; first/last name are optional (blank → null); email is optional but,
 * when present, must be a plausible address. Returns either the clean input or a
 * single error string — the caller turns the latter into a 400.
 */
function parseTextCustomerBody(
  req: Request
): { value: TextCustomerInput } | { error: string } {
  const phone = str(req.body?.phone);
  if (!phone) {
    return { error: "phone is required" };
  }
  const email = str(req.body?.email);
  if (email && !EMAIL_RE.test(email)) {
    return { error: "email must be a valid email address" };
  }
  return {
    value: {
      phone,
      firstName: str(req.body?.firstName) || null,
      lastName: str(req.body?.lastName) || null,
      email: email || null,
    },
  };
}

/** Normalize a phone-numbers input into a clean string[] (drops blanks). */
function phoneList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => (typeof v === "string" ? v.trim() : ""))
    .filter((v) => v.length > 0);
}
