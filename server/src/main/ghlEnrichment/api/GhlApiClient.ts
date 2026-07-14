import axios, { AxiosInstance, AxiosRequestConfig } from "axios";
import { injectable } from "tsyringe";
import { ExternalActionGuard } from "../../safety/ExternalActionGuard";
import { GhlEnrichmentConfig } from "../config/GhlEnrichmentConfig";
import { GhlConnectionService } from "../connections/GhlConnectionService";
import { GhlConnection } from "../connections/GhlConnectionTypes";
import {
  CreateCustomFieldInput,
  GhlContact,
  GhlCustomField,
  GhlCustomFieldValue,
  GhlNote,
  GhlSmsSendResult,
  UpsertContactInput,
} from "./GhlApiTypes";

/** Raised when no active connection exists for a location — callers stop processing. */
export class GhlConnectionUnavailableError extends Error {
  constructor(public readonly locationId: string, reason: string) {
    super(`No usable GHL connection for location ${locationId}: ${reason}`);
    this.name = "GhlConnectionUnavailableError";
  }
}

/**
 * A fixed, non-secret timestamp for the synthetic gateway connection (JAK-163).
 * The gateway creds come from Doppler, not a DB row, so there are no real
 * created/updated times — and {@link GhlApiClient.createHttpClient} only reads
 * `baseUrl` + `apiKey` anyway. A constant epoch keeps the shape valid without
 * introducing nondeterminism.
 */
const GATEWAY_CONNECTION_TIMESTAMP = new Date(0);

/** Raised when a GHL request ultimately fails (after any retries). */
export class GhlApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly method?: string,
    public readonly url?: string
  ) {
    super(message);
    this.name = "GhlApiError";
  }
}

/**
 * Multi-tenant GHL API v2 client (JAK-104).
 *
 * This is the canonical, per-location client: every call resolves the caller's
 * credentials from the JAK-102 encrypted connection store
 * ({@link GhlConnectionService} → decrypted `apiKey` + per-location `base_url`),
 * NOT from a single app-wide Doppler key. Doppler holds only the app-level
 * encryption key. The worker/webhook paths use this client (JAK-106/JAK-107).
 *
 * ONE deliberate exception (JAK-163): the shared "Jake" GATEWAY sub-account's
 * credentials live in Doppler ({@link GhlEnrichmentConfig.gateway} — the SAME
 * master key outbound SMS uses), never pasted into the JAK-102 store. So when a
 * call targets the gateway location AND the store has no connection for it, we
 * fall back to those Doppler creds instead of failing "not connected" — see
 * {@link httpFor}. A REAL store connection for a location always wins (the
 * own_number multi-tenant path is untouched); the fallback is gateway-only.
 *
 * Responsibilities:
 *  - Inject the correct per-location Bearer token + base URL (one cached axios
 *    instance per location).
 *  - Retry transient failures (429 rate-limit, 5xx, network) with exponential
 *    backoff, honouring `Retry-After` on 429. 4xx (other) fail fast.
 *  - Enforce SPEC §8 write-safety: dev never writes to a real GHL sub-account.
 *    The gate lives at the single {@link request} chokepoint (JAK-110) — every
 *    mutating verb (POST/PUT/PATCH/DELETE) is echoed + skipped off prod/staging
 *    via the shared {@link ExternalActionGuard}, so a new write method can never
 *    forget the guard. Reads (GET) are free and pass through.
 *
 * Thin by design — only the methods the enrichment MVP needs.
 */
@injectable()
export class GhlApiClient {
  /** GHL API version pin, matching the rest of the app. */
  private static readonly API_VERSION = "2021-07-28";
  private static readonly REQUEST_TIMEOUT_MS = 30_000;
  private static readonly MAX_RETRIES = 3;
  private static readonly BASE_BACKOFF_MS = 500;
  private static readonly MAX_BACKOFF_MS = 20_000;

  /** One axios instance per location id, built lazily from stored credentials. */
  private readonly clients = new Map<string, AxiosInstance>();

  constructor(
    private readonly connections: GhlConnectionService,
    private readonly guard: ExternalActionGuard,
    private readonly config: GhlEnrichmentConfig
  ) {}

  // ────────────────────────────── Reads ──────────────────────────────

  /** Fetch a contact. Returns null if GHL reports it doesn't exist (404). */
  async getContact(locationId: string, contactId: string): Promise<GhlContact | null> {
    const data = await this.request<{ contact?: GhlContact } | null>(
      locationId,
      { method: "GET", url: `/contacts/${contactId}` },
      { notFoundAsNull: true }
    );
    return data?.contact ?? null;
  }

  /** List every custom field defined on a location (write-back targeting, JAK-108). */
  async listCustomFields(locationId: string): Promise<GhlCustomField[]> {
    const data = await this.request<{ customFields?: GhlCustomField[] }>(locationId, {
      method: "GET",
      url: `/locations/${locationId}/customFields`,
    });
    return data?.customFields ?? [];
  }

  /**
   * Find a single contact in a location by phone number (JAK-147) — GHL v2's
   * duplicate-search endpoint. Returns the matched contact, or null when the
   * location has no contact on that number. A READ, so it passes through in every
   * environment (only writes are gated). Used to prefill the admin form and to
   * confirm a texter's existing contact.
   */
  async findContactByPhone(locationId: string, phone: string): Promise<GhlContact | null> {
    const data = await this.request<{ contact?: GhlContact } | null>(
      locationId,
      {
        method: "GET",
        url: "/contacts/search/duplicate",
        params: { locationId, number: phone },
      },
      { notFoundAsNull: true }
    );
    return data?.contact ?? null;
  }

  // ────────────────────────────── Writes ─────────────────────────────
  // SPEC §8: these never touch a real GHL location off-prod. No per-method
  // guard — the mutating verb is caught at the single request() chokepoint
  // below, which echoes + skips off prod/staging and returns null.

  /** Write enrichment values onto a contact's custom fields. */
  async updateContactCustomFields(
    locationId: string,
    contactId: string,
    customFields: GhlCustomFieldValue[]
  ): Promise<void> {
    await this.request<unknown>(locationId, {
      method: "PUT",
      url: `/contacts/${contactId}`,
      data: { customFields },
    });
  }

  /**
   * Find-or-create a contact by phone in a location and write its profile +
   * custom fields (JAK-147) — GHL v2's `POST /contacts/upsert`. IDEMPOTENT: the
   * phone is the dedupe key, so re-upserting the same number updates the SAME
   * contact rather than duplicating it (re-saving a text customer is safe). As a
   * POST it's gated at the {@link request} chokepoint — off prod/staging it's
   * echoed + skipped (returns null), so dev never writes to a real sub-account.
   */
  async upsertContact(
    locationId: string,
    input: UpsertContactInput
  ): Promise<GhlContact | null> {
    const data: Record<string, unknown> = {
      locationId,
      phone: input.phone,
    };
    // Only send fields we actually have — never blank a value with null.
    if (input.firstName != null) data.firstName = input.firstName;
    if (input.lastName != null) data.lastName = input.lastName;
    if (input.email != null) data.email = input.email;
    if (input.customFields && input.customFields.length > 0) {
      data.customFields = input.customFields;
    }
    const res = await this.request<{ contact?: GhlContact } | null>(locationId, {
      method: "POST",
      url: "/contacts/upsert",
      data,
    });
    return res?.contact ?? null;
  }

  /** Attach a note to a contact (the "Jake Enrichment" note). Null when skipped off-prod. */
  async createNote(
    locationId: string,
    contactId: string,
    body: string
  ): Promise<GhlNote | null> {
    const data = await this.request<{ note?: GhlNote }>(locationId, {
      method: "POST",
      url: `/contacts/${contactId}/notes`,
      data: { body },
    });
    return data?.note ?? null;
  }

  /** Provision a custom field on a location (install lifecycle, JAK-105). Null when skipped off-prod. */
  async createCustomField(
    locationId: string,
    input: CreateCustomFieldInput
  ): Promise<GhlCustomField | null> {
    const data = await this.request<{ customField?: GhlCustomField }>(locationId, {
      method: "POST",
      url: `/locations/${locationId}/customFields`,
      data: {
        name: input.name,
        dataType: input.dataType,
        ...(input.fieldKey ? { fieldKey: input.fieldKey } : {}),
        ...(input.parentId ? { parentId: input.parentId } : {}),
      },
    });
    return data?.customField ?? null;
  }

  /**
   * Send an outbound SMS reply to a contact on THIS location's credentials
   * (JAK-114 / the JAK-002 send path) via the GHL Conversations API. The reply
   * therefore always goes back through the tenant that owns `locationId` — never
   * another tenant's GHL. `fromNumber` is optional; omitted → the location's
   * default number. As a POST it's gated at the {@link request} chokepoint, so
   * off prod/staging it's echoed + skipped (returns null) — dev never texts a
   * real person.
   */
  async sendSms(
    locationId: string,
    params: { contactId: string; message: string; fromNumber?: string }
  ): Promise<GhlSmsSendResult | null> {
    const data: Record<string, unknown> = {
      type: "SMS",
      contactId: params.contactId,
      message: params.message,
    };
    if (params.fromNumber) {
      data.fromNumber = params.fromNumber;
    }

    return this.request<GhlSmsSendResult | null>(locationId, {
      method: "POST",
      url: "/conversations/messages",
      data,
    });
  }

  // ──────────────────────────── Internals ────────────────────────────

  /**
   * Resolve (and cache) the axios instance for a location, wiring its decrypted
   * per-location credentials. Throws {@link GhlConnectionUnavailableError} if
   * the location is unknown or inactive (uninstalled) — callers stop processing.
   *
   * A REAL store connection always wins (own_number multi-tenant path). Only
   * when the store has NO connection for the location do we consider the JAK-163
   * gateway fallback: if this IS the gateway location and its Doppler master
   * creds are configured, auth with those (the same key SMS uses) instead of
   * failing "not connected". An unconfigured gateway resolves to no connection,
   * so the caller surfaces a graceful "not connected / not configured" message.
   */
  private async httpFor(locationId: string): Promise<AxiosInstance> {
    const cached = this.clients.get(locationId);
    if (cached) return cached;

    const conn =
      (await this.connections.getByLocationId(locationId)) ??
      this.gatewayConnectionFor(locationId);
    if (!conn) {
      throw new GhlConnectionUnavailableError(locationId, "no connection on file");
    }
    if (conn.status !== "active") {
      throw new GhlConnectionUnavailableError(locationId, `status is ${conn.status}`);
    }

    const client = this.createHttpClient(conn);
    this.clients.set(locationId, client);
    return client;
  }

  /**
   * Build a synthetic {@link GhlConnection} from the Doppler gateway master creds
   * (JAK-163) — but ONLY for the gateway location itself, and ONLY when those
   * creds are actually configured. Returns null otherwise (not the gateway
   * location, or gateway unset), so the caller falls through to the normal
   * "no connection on file" path and the admin sees a graceful message rather
   * than a crash. The master key is scoped to this one sub-account and, like
   * every credential here, is never logged.
   */
  private gatewayConnectionFor(locationId: string): GhlConnection | null {
    const { apiKey, baseUrl, locationId: gatewayLocationId } = this.config.gateway;
    const gatewayLoc = (gatewayLocationId || "").trim();
    if (!gatewayLoc || locationId !== gatewayLoc) return null;
    if (!apiKey || !baseUrl) return null;
    return {
      id: `gateway:${gatewayLoc}`,
      locationId: gatewayLoc,
      name: null,
      apiKey,
      baseUrl,
      phoneNumbers: [],
      status: "active",
      textMode: "gateway",
      // JAK-186: the gateway is a text-routing identity, not an enrichment target.
      autoEnrichmentEnabled: false,
      // JAK-191: not an enrichment target, so unlimited is meaningless here.
      unlimitedCredits: false,
      createdAt: GATEWAY_CONNECTION_TIMESTAMP,
      updatedAt: GATEWAY_CONNECTION_TIMESTAMP,
    };
  }

  /**
   * Build a per-location axios instance. Protected so tests can substitute a
   * mocked transport without hitting the network. The Bearer token is the
   * decrypted per-location key and is NEVER logged.
   */
  protected createHttpClient(conn: GhlConnection): AxiosInstance {
    return axios.create({
      baseURL: conn.baseUrl,
      headers: {
        Authorization: `Bearer ${conn.apiKey}`,
        Version: GhlApiClient.API_VERSION,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      timeout: GhlApiClient.REQUEST_TIMEOUT_MS,
    });
  }

  /**
   * Issue a request with retry + rate-limit backoff. Retries 429 / 5xx / network
   * errors up to {@link MAX_RETRIES}; other 4xx fail fast. With
   * `notFoundAsNull`, a 404 resolves to null instead of throwing.
   */
  private async request<T>(
    locationId: string,
    config: AxiosRequestConfig,
    opts: { notFoundAsNull?: boolean } = {}
  ): Promise<T> {
    const method = (config.method ?? "GET").toString().toUpperCase();

    // SPEC §8 / JAK-110 — the single write-safety gate. Every mutating verb
    // funnels through here, so no write method can bypass it. Off prod/staging
    // we echo the intended write and skip it (no connection resolved, no HTTP),
    // returning null so callers surface "skipped" cleanly. Reads pass through.
    if (this.isMutation(method) && !this.guard.liveActionsAllowed) {
      this.guard.echoSkipped(
        "GHL write",
        `${method} ${config.url} (location ${locationId})`
      );
      return null as T;
    }

    const http = await this.httpFor(locationId);

    let lastError: unknown;
    for (let attempt = 0; attempt <= GhlApiClient.MAX_RETRIES; attempt++) {
      try {
        const response = await http.request<T>(config);
        return response.data;
      } catch (err) {
        lastError = err;
        const status = axios.isAxiosError(err) ? err.response?.status : undefined;

        if (opts.notFoundAsNull && status === 404) {
          return null as T;
        }

        const isLastAttempt = attempt === GhlApiClient.MAX_RETRIES;
        if (!this.isRetriable(status) || isLastAttempt) {
          throw new GhlApiError(
            `GHL ${method} ${config.url} failed` +
              (status ? ` with status ${status}` : ` (${this.errorSummary(err)})`),
            status,
            method,
            config.url
          );
        }

        await this.delay(this.backoffMs(attempt, err));
      }
    }
    // Unreachable — the loop either returns or throws — but satisfies the compiler.
    throw new GhlApiError(
      `GHL ${method} ${config.url} failed (${this.errorSummary(lastError)})`,
      undefined,
      method,
      config.url
    );
  }

  /** Retry only transient failures: rate-limit, server errors, and network drops. */
  private isRetriable(status: number | undefined): boolean {
    if (status === undefined) return true; // network / timeout, no response
    if (status === 429) return true;
    return status >= 500 && status <= 599;
  }

  /**
   * Backoff for a given attempt. On 429 with a numeric `Retry-After` (seconds),
   * honour it; otherwise exponential (base·2^attempt) with jitter, capped.
   */
  private backoffMs(attempt: number, err: unknown): number {
    if (axios.isAxiosError(err) && err.response?.status === 429) {
      const retryAfter = Number(err.response.headers?.["retry-after"]);
      if (Number.isFinite(retryAfter) && retryAfter > 0) {
        return Math.min(retryAfter * 1000, GhlApiClient.MAX_BACKOFF_MS);
      }
    }
    const exponential = GhlApiClient.BASE_BACKOFF_MS * 2 ** attempt;
    const jitter = Math.floor(Math.random() * GhlApiClient.BASE_BACKOFF_MS);
    return Math.min(exponential + jitter, GhlApiClient.MAX_BACKOFF_MS);
  }

  /** A short, secret-free description of an error for logs/messages. */
  private errorSummary(err: unknown): string {
    if (axios.isAxiosError(err)) return err.code ?? err.message;
    return err instanceof Error ? err.message : "unknown error";
  }

  /** Whether an HTTP verb mutates state (and so must be gated off prod/staging). */
  private isMutation(method: string): boolean {
    return method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
  }

  /** Sleep helper. Protected so tests can stub it out to run instantly. */
  protected delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
