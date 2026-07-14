import { injectable } from "tsyringe";
import { GhlConnectionService } from "../connections/GhlConnectionService";
import { GhlConnection } from "../connections/GhlConnectionTypes";
import { GhlInstallLifecycleService } from "../lifecycle/GhlInstallLifecycleService";
import { CreditService } from "../metering/CreditService";
import { CreditLedgerRow } from "../metering/CreditLedgerStore";
import { AdminConnectionView } from "./AdminTypes";

/** The constant mask shown for a stored API key — never the real value. */
export const API_KEY_MASK = "••••••••";

export interface CreateConnectionInput {
  locationId: string;
  /** JAK-190 — optional friendly label. */
  name?: string | null;
  apiKey: string;
  baseUrl: string;
  phoneNumbers?: string[];
}

export interface UpdateConnectionInput {
  /** JAK-190 — edit the friendly label ("" / null clears it). */
  name?: string | null;
  /** Optional rotation — a new plaintext key; omit to keep the stored one. */
  apiKey?: string;
  baseUrl?: string;
  phoneNumbers?: string[];
  /** JAK-186 — flip the per-location auto-enrichment toggle on/off. */
  autoEnrichmentEnabled?: boolean;
}

/**
 * The admin dashboard's write surface over connected sub-accounts (JAK-113).
 *
 * A THIN adapter — it owns no business logic. It delegates create/edit/rotate to
 * {@link GhlConnectionService} (which encrypts the key at rest via the JAK-102
 * cipher), deactivation to the JAK-104/110 inactive path via
 * {@link GhlInstallLifecycleService}, and manual credit grants to
 * {@link CreditService}. Its ONE real responsibility is safety: every value it
 * returns is mapped to the masked {@link AdminConnectionView} so a decrypted key
 * never reaches the client — the plaintext key is write-only.
 */
@injectable()
export class AdminConnectionService {
  constructor(
    private readonly connections: GhlConnectionService,
    private readonly lifecycle: GhlInstallLifecycleService,
    private readonly credits: CreditService
  ) {}

  /** Connect a new sub-account. The key is encrypted before it touches the DB. */
  async create(input: CreateConnectionInput): Promise<AdminConnectionView> {
    const conn = await this.connections.createConnection({
      locationId: input.locationId,
      name: input.name ?? null,
      apiKey: input.apiKey,
      baseUrl: input.baseUrl,
      phoneNumbers: input.phoneNumbers ?? [],
      status: "active",
    });
    return toView(conn);
  }

  /**
   * Edit a sub-account. A provided `apiKey` rotates the stored (encrypted) key;
   * omit it to leave the key untouched. Returns null if the location is unknown.
   */
  async update(
    locationId: string,
    patch: UpdateConnectionInput
  ): Promise<AdminConnectionView | null> {
    const conn = await this.connections.updateConnection(locationId, {
      name: patch.name,
      apiKey: patch.apiKey,
      baseUrl: patch.baseUrl,
      phoneNumbers: patch.phoneNumbers,
      autoEnrichmentEnabled: patch.autoEnrichmentEnabled,
    });
    return conn ? toView(conn) : null;
  }

  /**
   * Deactivate a sub-account via the JAK-104/110 inactive path — the API client
   * refuses to serve inactive connections, so processing stops. Returns false if
   * the location is unknown.
   */
  async deactivate(locationId: string): Promise<boolean> {
    return this.lifecycle.uninstall(locationId);
  }

  /** Re-activate a previously deactivated sub-account. Null if unknown. */
  async activate(locationId: string): Promise<AdminConnectionView | null> {
    const conn = await this.connections.updateConnection(locationId, {
      status: "active",
    });
    return conn ? toView(conn) : null;
  }

  /** Permanently remove a sub-account connection. True if one was deleted. */
  async delete(locationId: string): Promise<boolean> {
    return this.connections.deleteConnection(locationId);
  }

  /**
   * The DECRYPTED per-location inbound webhook key (JAK-189) for admin display —
   * the value the sub-account owner pastes into GHL's `x-api-key` header. Null if
   * the location is unknown or (transiently, pre-backfill) has no key yet. This is
   * the ONE admin surface that returns a real key; guard it with admin auth.
   */
  async getWebhookKey(locationId: string): Promise<string | null> {
    return this.connections.getWebhookKey(locationId);
  }

  /**
   * Rotate a location's webhook key (JAK-189). Returns the NEW plaintext key (shown
   * once); the old key stops authenticating immediately. Null if the location is
   * unknown.
   */
  async regenerateWebhookKey(locationId: string): Promise<string | null> {
    return this.connections.regenerateWebhookKey(locationId);
  }

  /**
   * Manually grant (or, with a negative amount, adjust) a location's credit
   * balance — the beta top-up path (Stripe billing is deferred). Returns the new
   * balance, or null if the location is unknown.
   */
  async grantCredits(
    locationId: string,
    amount: number,
    reason?: string
  ): Promise<CreditLedgerRow | null> {
    const conn = await this.connections.getByLocationId(locationId);
    if (!conn) return null;
    return this.credits.grantCredits(
      locationId,
      amount,
      reason === "adjustment" ? "adjustment" : "manual_grant"
    );
  }
}

/** Map a decrypted connection to the masked, key-free admin view. */
function toView(conn: GhlConnection): AdminConnectionView {
  return {
    id: conn.id,
    locationId: conn.locationId,
    name: conn.name,
    baseUrl: conn.baseUrl,
    phoneNumbers: conn.phoneNumbers,
    status: conn.status,
    autoEnrichmentEnabled: conn.autoEnrichmentEnabled,
    apiKeyMasked: API_KEY_MASK,
    createdAt: conn.createdAt,
    updatedAt: conn.updatedAt,
  };
}
