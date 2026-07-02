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
    api_key_encrypted: cipher.encrypt("plaintext-key"),
    base_url: "https://services.leadconnectorhq.com",
    phone_numbers: ["+15551234567"],
    status: "active",
    text_mode: "gateway",
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
    // Round-trips back to plaintext for the caller.
    expect(conn.apiKey).toBe("plaintext-key");
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
