import { mock, MockProxy } from "jest-mock-extended";
import { GhlConnectionService } from "../GhlConnectionService";
import { GhlConnectionRow, GhlConnectionStore } from "../GhlConnectionStore";
import { CredentialCipher } from "../CredentialCipher";
import { GhlEnrichmentConfig } from "../../config/GhlEnrichmentConfig";

describe("GhlConnectionService", () => {
  let store: MockProxy<GhlConnectionStore>;
  let cipher: CredentialCipher;
  let service: GhlConnectionService;

  const row = (over: Partial<GhlConnectionRow> = {}): GhlConnectionRow => ({
    id: "11111111-1111-1111-1111-111111111111",
    location_id: "loc_abc",
    name: null,
    api_key_encrypted: cipher.encrypt("plaintext-key"),
    base_url: "https://services.leadconnectorhq.com",
    phone_numbers: ["+15551234567"],
    status: "active",
    text_mode: "gateway",
    auto_enrichment_enabled: false,
    unlimited_credits: false,
    webhook_key_hash: null,
    webhook_key_enc: null,
    created_at: new Date("2026-07-01T00:00:00Z"),
    updated_at: new Date("2026-07-01T00:00:00Z"),
    ...over,
  });

  beforeEach(() => {
    store = mock<GhlConnectionStore>();
    cipher = new CredentialCipher({
      credentialEncryptionKey: "unit-test-key",
    } as GhlEnrichmentConfig);
    service = new GhlConnectionService(store, cipher);
  });

  it("encrypts the API key before persisting on create", async () => {
    store.insert.mockImplementation(async (r) => row({ api_key_encrypted: r.api_key_encrypted }));

    const conn = await service.createConnection({
      locationId: "loc_abc",
      apiKey: "plaintext-key",
      baseUrl: "https://services.leadconnectorhq.com",
      phoneNumbers: ["+15551234567"],
    });

    const inserted = store.insert.mock.calls[0][0];
    expect(inserted.api_key_encrypted).not.toContain("plaintext-key");
    expect(inserted.status).toBe("active"); // defaulted
    // JAK-186: auto-enrichment is opt-in — a new connection defaults to OFF.
    expect(inserted.auto_enrichment_enabled).toBe(false);
    // Round-trips back to plaintext for the caller.
    expect(conn.apiKey).toBe("plaintext-key");
  });

  describe("friendly name (JAK-190)", () => {
    it("persists a name on create and maps it back", async () => {
      store.insert.mockImplementation(async (r) => row({ name: r.name }));
      const conn = await service.createConnection({
        locationId: "loc_abc",
        name: "Acme Realty",
        apiKey: "plaintext-key",
        baseUrl: "https://x.co",
      });
      expect(store.insert.mock.calls[0][0].name).toBe("Acme Realty");
      expect(conn.name).toBe("Acme Realty");
    });

    it("defaults name to null when omitted on create", async () => {
      store.insert.mockImplementation(async (r) => row({ name: r.name }));
      const conn = await service.createConnection({
        locationId: "loc_abc",
        apiKey: "plaintext-key",
        baseUrl: "https://x.co",
      });
      expect(store.insert.mock.calls[0][0].name).toBeNull();
      expect(conn.name).toBeNull();
    });

    it("updates the name (and clears it with null)", async () => {
      store.update.mockImplementation(async (_loc, patch) => row({ name: patch.name ?? null }));

      const renamed = await service.updateConnection("loc_abc", { name: "New Name" });
      expect(store.update.mock.calls[0][1].name).toBe("New Name");
      expect(renamed?.name).toBe("New Name");

      const cleared = await service.updateConnection("loc_abc", { name: null });
      expect(store.update.mock.calls[1][1].name).toBeNull();
      expect(cleared?.name).toBeNull();
    });

    it("leaves the name untouched when the patch omits it", async () => {
      store.update.mockImplementation(async () => row({ name: "Existing" }));
      await service.updateConnection("loc_abc", { baseUrl: "https://y.co" });
      expect(store.update.mock.calls[0][1].name).toBeUndefined();
    });

    it("surfaces the name on read", async () => {
      store.findByLocationId.mockResolvedValue(row({ name: "Read Name" }));
      const conn = await service.getByLocationId("loc_abc");
      expect(conn?.name).toBe("Read Name");
    });
  });

  describe("unlimited credits (JAK-191)", () => {
    it("defaults unlimited_credits to false on create", async () => {
      store.insert.mockImplementation(async (r) => row({ unlimited_credits: r.unlimited_credits }));
      const conn = await service.createConnection({
        locationId: "loc_abc",
        apiKey: "plaintext-key",
        baseUrl: "https://x.co",
      });
      expect(store.insert.mock.calls[0][0].unlimited_credits).toBe(false);
      expect(conn.unlimitedCredits).toBe(false);
    });

    it("toggles unlimited_credits on update and maps it back", async () => {
      store.update.mockImplementation(async (_loc, patch) =>
        row({ unlimited_credits: patch.unlimited_credits ?? false })
      );
      const conn = await service.updateConnection("loc_abc", { unlimitedCredits: true });
      expect(store.update.mock.calls[0][1].unlimited_credits).toBe(true);
      expect(conn?.unlimitedCredits).toBe(true);
    });

    it("surfaces unlimitedCredits on read", async () => {
      store.findByLocationId.mockResolvedValue(row({ unlimited_credits: true }));
      const conn = await service.getByLocationId("loc_abc");
      expect(conn?.unlimitedCredits).toBe(true);
    });
  });

  describe("per-location webhook key (JAK-189)", () => {
    it("mints a webhook key on create — hash + encrypted, and they round-trip", async () => {
      store.insert.mockImplementation(async (r) => row(r));

      await service.createConnection({
        locationId: "loc_abc",
        apiKey: "plaintext-key",
        baseUrl: "https://x.co",
      });

      const inserted = store.insert.mock.calls[0][0];
      expect(inserted.webhook_key_hash).toMatch(/^[0-9a-f]{64}$/); // SHA-256 hex
      expect(inserted.webhook_key_enc).toMatch(/^v1:/); // encrypted, not plaintext
      // The encrypted copy decrypts to a prefixed key whose SHA-256 is the stored hash.
      const decrypted = cipher.decrypt(inserted.webhook_key_enc);
      expect(decrypted.startsWith("jakewh_")).toBe(true);
      const { hashWebhookKey } = await import("../WebhookKey");
      expect(hashWebhookKey(decrypted)).toBe(inserted.webhook_key_hash);
    });

    it("resolves a location BY the presented key (hash lookup)", async () => {
      const stored = row();
      store.findByWebhookKeyHash.mockResolvedValue(stored);

      const conn = await service.getByWebhookKey("jakewh_presented");

      const { hashWebhookKey } = await import("../WebhookKey");
      expect(store.findByWebhookKeyHash).toHaveBeenCalledWith(hashWebhookKey("jakewh_presented"));
      expect(conn?.locationId).toBe("loc_abc");
    });

    it("returns null when no location owns the presented key", async () => {
      store.findByWebhookKeyHash.mockResolvedValue(null);
      expect(await service.getByWebhookKey("jakewh_nobody")).toBeNull();
    });

    it("getWebhookKey decrypts the stored key for admin display", async () => {
      const key = "jakewh_abc123";
      store.findByLocationId.mockResolvedValue(row({ webhook_key_enc: cipher.encrypt(key) }));
      expect(await service.getWebhookKey("loc_abc")).toBe(key);
    });

    it("getWebhookKey returns null for an unknown location", async () => {
      store.findByLocationId.mockResolvedValue(null);
      expect(await service.getWebhookKey("nope")).toBeNull();
    });

    it("regenerate changes BOTH hash + enc and returns the new plaintext key", async () => {
      store.update.mockImplementation(async (_loc, patch) => row(patch));
      const newKey = await service.regenerateWebhookKey("loc_abc");

      expect(newKey).not.toBeNull();
      expect(newKey!.startsWith("jakewh_")).toBe(true);
      const patch = store.update.mock.calls[0][1];
      const { hashWebhookKey } = await import("../WebhookKey");
      expect(patch.webhook_key_hash).toBe(hashWebhookKey(newKey!));
      expect(cipher.decrypt(patch.webhook_key_enc!)).toBe(newKey);
    });

    it("regenerate returns null for an unknown location", async () => {
      store.update.mockResolvedValue(null);
      expect(await service.regenerateWebhookKey("nope")).toBeNull();
    });

    it("ensureWebhookKeys backfills only the rows missing a key", async () => {
      store.listMissingWebhookKey.mockResolvedValue([
        row({ location_id: "loc_a" }),
        row({ location_id: "loc_b" }),
      ]);
      store.update.mockImplementation(async (_loc, patch) => row(patch));

      const filled = await service.ensureWebhookKeys();

      expect(filled).toBe(2);
      expect(store.update).toHaveBeenCalledTimes(2);
      for (const call of store.update.mock.calls) {
        expect(call[1].webhook_key_hash).toMatch(/^[0-9a-f]{64}$/);
        expect(call[1].webhook_key_enc).toMatch(/^v1:/);
      }
    });

    it("ensureWebhookKeys is a no-op (returns 0) when every row has a key", async () => {
      store.listMissingWebhookKey.mockResolvedValue([]);
      expect(await service.ensureWebhookKeys()).toBe(0);
      expect(store.update).not.toHaveBeenCalled();
    });
  });

  it("maps the auto-enrichment flag through on read (JAK-186)", async () => {
    store.findByLocationId.mockResolvedValue(row({ auto_enrichment_enabled: true }));
    const conn = await service.getByLocationId("loc_abc");
    expect(conn?.autoEnrichmentEnabled).toBe(true);
  });

  it("flips the auto-enrichment toggle on update (JAK-186)", async () => {
    store.update.mockImplementation(async (_loc, patch) =>
      row({ auto_enrichment_enabled: patch.auto_enrichment_enabled ?? false })
    );

    const conn = await service.updateConnection("loc_abc", { autoEnrichmentEnabled: true });

    expect(store.update.mock.calls[0][1].auto_enrichment_enabled).toBe(true);
    expect(conn?.autoEnrichmentEnabled).toBe(true);
  });

  it("resolves by location id and decrypts the key", async () => {
    store.findByLocationId.mockResolvedValue(row());

    const conn = await service.getByLocationId("loc_abc");

    expect(store.findByLocationId).toHaveBeenCalledWith("loc_abc");
    expect(conn?.apiKey).toBe("plaintext-key");
    expect(conn?.locationId).toBe("loc_abc");
  });

  it("resolves by phone number and decrypts the key", async () => {
    store.findByPhoneNumber.mockResolvedValue(row());

    const conn = await service.getByPhoneNumber("+15551234567");

    expect(store.findByPhoneNumber).toHaveBeenCalledWith("+15551234567");
    expect(conn?.apiKey).toBe("plaintext-key");
  });

  it("returns null when a resolver finds nothing", async () => {
    store.findByLocationId.mockResolvedValue(null);
    store.findByPhoneNumber.mockResolvedValue(null);
    expect(await service.getByLocationId("missing")).toBeNull();
    expect(await service.getByPhoneNumber("+10000000000")).toBeNull();
  });

  it("re-encrypts a new API key on update, but leaves it untouched when omitted", async () => {
    store.update.mockImplementation(async (_loc, patch) =>
      row({ api_key_encrypted: patch.api_key_encrypted ?? row().api_key_encrypted })
    );

    await service.updateConnection("loc_abc", { apiKey: "rotated-key" });
    let patch = store.update.mock.calls[0][1];
    expect(patch.api_key_encrypted).toBeDefined();
    expect(cipher.decrypt(patch.api_key_encrypted!)).toBe("rotated-key");

    await service.updateConnection("loc_abc", { status: "inactive" });
    patch = store.update.mock.calls[1][1];
    expect(patch.api_key_encrypted).toBeUndefined();
    expect(patch.status).toBe("inactive");
  });

  it("delegates delete to the store", async () => {
    store.delete.mockResolvedValue(true);
    expect(await service.deleteConnection("loc_abc")).toBe(true);
    expect(store.delete).toHaveBeenCalledWith("loc_abc");
  });
});
