import axios, { AxiosInstance, AxiosRequestConfig } from "axios";
import { injectable } from "tsyringe";
import { ExternalActionGuard } from "../../safety/ExternalActionGuard";
import { GhlEnrichmentConfig } from "../config/GhlEnrichmentConfig";
import { GhlNote, GhlSmsSendResult } from "../api/GhlApiTypes";

/** Raised when a gateway send/note is attempted but the master creds are unset. */
export class JakeGatewayUnavailableError extends Error {
  constructor(reason: string) {
    super(`Jake gateway is not usable: ${reason}`);
    this.name = "JakeGatewayUnavailableError";
  }
}

/**
 * The MASTER-KEY text-Jake client (JAK-115) — the 'gateway' text mode.
 *
 * This is the single-tenant counterpart to the multi-tenant
 * {@link import("../api/GhlApiClient").GhlApiClient}: instead of resolving
 * per-location credentials from the JAK-102 store, it talks to Zequi's ONE shared
 * "Jake" GHL sub-account using the app-level MASTER GATEWAY KEY from Doppler
 * ({@link GhlEnrichmentConfig.gateway}). It's what tier-1 / trial customers
 * (text_mode='gateway') text through — Zequi's number, Zequi pays the SMS.
 *
 * The master key is NEVER stored in the DB and NEVER per-tenant; it's read from
 * config (env) here and never logged. Only the two verbs text-Jake needs:
 * outbound SMS + a status note on the contact.
 *
 * SPEC §8 / JAK-110 write-safety is enforced at the single {@link write}
 * chokepoint — off prod/staging every write is echoed + skipped (returns null),
 * so dev never texts a real person or writes to the real gateway sub-account.
 */
@injectable()
export class JakeGatewayClient {
  private static readonly API_VERSION = "2021-07-28";
  private static readonly REQUEST_TIMEOUT_MS = 30_000;

  /** One lazily-built axios instance for the gateway sub-account. */
  private http?: AxiosInstance;

  constructor(
    private readonly config: GhlEnrichmentConfig,
    private readonly guard: ExternalActionGuard
  ) {}

  /** The gateway sub-account's GHL location id (for logging / context). */
  get locationId(): string {
    return this.config.gateway.locationId;
  }

  /**
   * The CONFIGURED default reply-from number for the gateway (JAK-force-fromnumber-833),
   * from Doppler (JAKE_GATEWAY_FROM_NUMBER). Empty string when unset. The gateway send
   * path uses it as the fallback when the inbound carries no destination to mirror, so
   * Jake replies from the provisioned toll-free number instead of GHL's sub-account
   * default. Must be a number provisioned in the gateway sub-account for GHL to send.
   */
  get defaultFromNumber(): string {
    return this.config.gateway.fromNumber;
  }

  /**
   * Send an outbound SMS reply to a contact in the gateway sub-account. As the
   * master key is scoped to that ONE sub-account, no location id is sent — the
   * key IS the location. `fromNumber` is optional; omitted → the gateway's
   * default number. Null off prod/staging (echoed + skipped).
   */
  async sendSms(params: {
    contactId: string;
    message: string;
    fromNumber?: string;
  }): Promise<GhlSmsSendResult | null> {
    const data: Record<string, unknown> = {
      type: "SMS",
      contactId: params.contactId,
      message: params.message,
    };
    if (params.fromNumber) {
      data.fromNumber = params.fromNumber;
    }
    return this.write<GhlSmsSendResult>(`send SMS to contact ${params.contactId}`, {
      method: "POST",
      url: "/conversations/messages",
      data,
    });
  }

  /**
   * Attach a status note to a contact in the gateway sub-account (JAK-115:
   * "looked up X" / "out of credits" / "lookup failed"). Null off prod/staging.
   */
  async createContactNote(contactId: string, body: string): Promise<GhlNote | null> {
    const res = await this.write<{ note?: GhlNote }>(`note on contact ${contactId}`, {
      method: "POST",
      url: `/contacts/${contactId}/notes`,
      data: { body },
    });
    return res?.note ?? null;
  }

  /**
   * The single write chokepoint. Off prod/staging (JAK-110) the real HTTP call is
   * echoed + skipped so dev is structurally safe. Otherwise it issues the request
   * on the lazily-built master-key client.
   */
  private async write<T>(action: string, config: AxiosRequestConfig): Promise<T | null> {
    if (!this.guard.liveActionsAllowed) {
      this.guard.echoSkipped("Jake gateway write", `${action} (${config.method} ${config.url})`);
      return null;
    }
    const response = await this.httpClient().request<T>(config);
    return response.data;
  }

  /**
   * Build (and cache) the master-key axios instance. Protected so tests can
   * substitute a fake transport. Throws if the gateway creds are unconfigured —
   * we never fall back to another key. The Bearer token is NEVER logged.
   */
  protected httpClient(): AxiosInstance {
    if (this.http) return this.http;

    const { apiKey, baseUrl } = this.config.gateway;
    if (!apiKey || !baseUrl) {
      throw new JakeGatewayUnavailableError("master gateway credentials are not configured");
    }

    this.http = axios.create({
      baseURL: baseUrl,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Version: JakeGatewayClient.API_VERSION,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      timeout: JakeGatewayClient.REQUEST_TIMEOUT_MS,
    });
    return this.http;
  }
}
