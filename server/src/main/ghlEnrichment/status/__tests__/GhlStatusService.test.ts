import { mock, MockProxy } from "jest-mock-extended";
import { GhlConnectionStore, GhlConnectionRow } from "../../connections/GhlConnectionStore";
import { GhlCustomFieldStore } from "../../lifecycle/GhlCustomFieldStore";
import { CreditLedgerStore, CreditLedgerRow } from "../../metering/CreditLedgerStore";
import {
  GhlEnrichmentEventStore,
  GhlEnrichmentEventRow,
} from "../../worker/GhlEnrichmentEventStore";
import { GhlStatusService } from "../GhlStatusService";

const connectionRow = (over: Partial<GhlConnectionRow> = {}): GhlConnectionRow => ({
  id: "11111111-1111-1111-1111-111111111111",
  location_id: "loc_1",
  name: null,
  // A credential-shaped value the status view must NEVER echo back.
  api_key_encrypted: "v1:aead:ZmFrZS1jaXBoZXItYmxvYg==:not-a-real-secret",
  base_url: "https://services.leadconnectorhq.com",
  phone_numbers: ["+15551230001", "+15551230002"],
  status: "active",
  text_mode: "gateway",
  auto_enrichment_enabled: false,
  unlimited_credits: false,
  webhook_key_hash: null,
  webhook_key_enc: null,
  created_at: new Date("2026-06-01T00:00:00Z"),
  updated_at: new Date("2026-06-15T00:00:00Z"),
  ...over,
});

const eventRow = (over: Partial<GhlEnrichmentEventRow> = {}): GhlEnrichmentEventRow => ({
  id: "evt-1",
  location_id: "loc_1",
  contact_id: "ct_1",
  status: "failed",
  detail: "write-back: GHL 500",
  cost_estimate: 1,
  attempt_count: 3,
  enriched_at: null,
  failed_at: new Date("2026-06-20T00:00:00Z"),
  created_at: new Date("2026-06-19T00:00:00Z"),
  modified_at: new Date("2026-06-20T00:00:00Z"),
  ...over,
});

const ledgerRow = (over: Partial<CreditLedgerRow> = {}): CreditLedgerRow => ({
  id: "led-1",
  location_id: "loc_1",
  credit_type: "report",
  amount: -1,
  balance_after: 41,
  reason: "enrichment",
  contact_id: "ct_1",
  created_at: new Date("2026-06-20T00:00:00Z"),
  modified_at: new Date("2026-06-20T00:00:00Z"),
  deleted_at: null,
  ...over,
});

describe("GhlStatusService", () => {
  let connections: MockProxy<GhlConnectionStore>;
  let customFields: MockProxy<GhlCustomFieldStore>;
  let events: MockProxy<GhlEnrichmentEventStore>;
  let ledger: MockProxy<CreditLedgerStore>;
  let service: GhlStatusService;

  beforeEach(() => {
    connections = mock<GhlConnectionStore>();
    customFields = mock<GhlCustomFieldStore>();
    events = mock<GhlEnrichmentEventStore>();
    ledger = mock<CreditLedgerStore>();
    service = new GhlStatusService(connections, customFields, events, ledger);
  });

  describe("listLocationStatuses", () => {
    it("folds grouped scans into a per-location summary (connection + balance + counts)", async () => {
      connections.listAll.mockResolvedValue([
        connectionRow({ location_id: "loc_1" }),
        connectionRow({
          location_id: "loc_2",
          name: "Second Co", // JAK-190: a friendly name surfaces in the status view.
          status: "inactive",
          phone_numbers: [],
          // JAK-186: the toggle maps independently of connection status.
          auto_enrichment_enabled: true,
          unlimited_credits: true, // JAK-191: unlimited flag surfaces in the status view.
        }),
      ]);
      customFields.countByLocationForAll.mockResolvedValue([
        { location_id: "loc_1", count: 7 },
      ]);
      ledger.listBalances.mockResolvedValue([
        { location_id: "loc_1", balance: 41 },
        { location_id: "loc_2", balance: 0 },
      ]);
      events.countByStatusForAllLocations.mockResolvedValue([
        { location_id: "loc_1", status: "enriched", count: 5 },
        { location_id: "loc_1", status: "failed", count: 2 },
      ]);

      const result = await service.listLocationStatuses();

      expect(result).toHaveLength(2);
      const [loc1, loc2] = result;

      expect(loc1.connection).toEqual({
        locationId: "loc_1",
        name: null,
        status: "active",
        baseUrl: "https://services.leadconnectorhq.com",
        phoneNumberCount: 2,
        provisionedFieldCount: 7,
        autoEnrichmentEnabled: false,
        unlimitedCredits: false,
        installedAt: new Date("2026-06-01T00:00:00Z"),
        updatedAt: new Date("2026-06-15T00:00:00Z"),
      });
      expect(loc1.creditBalance).toBe(41);
      expect(loc1.outcomes).toEqual({
        enriched: 5,
        skipped: 0,
        credit_blocked: 0,
        failed: 2,
        dead_letter: 0,
        total: 7,
      });

      // loc_2 has no fields, no events — everything zero-fills cleanly.
      expect(loc2.connection.provisionedFieldCount).toBe(0);
      expect(loc2.connection.phoneNumberCount).toBe(0);
      // JAK-186: the service surfaces the per-location toggle it read from the row.
      expect(loc1.connection.autoEnrichmentEnabled).toBe(false);
      expect(loc2.connection.autoEnrichmentEnabled).toBe(true);
      // JAK-190: the friendly name is surfaced when set.
      expect(loc2.connection.name).toBe("Second Co");
      // JAK-191: the unlimited-credits flag is surfaced.
      expect(loc1.connection.unlimitedCredits).toBe(false);
      expect(loc2.connection.unlimitedCredits).toBe(true);
      expect(loc2.creditBalance).toBe(0);
      expect(loc2.outcomes.total).toBe(0);
    });

    it("NEVER exposes the encrypted API key in any summary field", async () => {
      connections.listAll.mockResolvedValue([connectionRow()]);
      customFields.countByLocationForAll.mockResolvedValue([]);
      ledger.listBalances.mockResolvedValue([]);
      events.countByStatusForAllLocations.mockResolvedValue([]);

      const result = await service.listLocationStatuses();

      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("api_key");
      expect(serialized).not.toContain("not-a-real-secret");
      expect(result[0].connection).not.toHaveProperty("apiKey");
      expect(result[0].connection).not.toHaveProperty("api_key_encrypted");
    });
  });

  describe("getLocationStatus", () => {
    it("returns null for a location that was never installed", async () => {
      connections.findByLocationId.mockResolvedValue(null);
      expect(await service.getLocationStatus("nope")).toBeNull();
    });

    it("assembles full health from the stores and surfaces failures with their reason", async () => {
      connections.findByLocationId.mockResolvedValue(connectionRow());
      customFields.listByLocation.mockResolvedValue([
        { id: "f1" } as never,
        { id: "f2" } as never,
      ]);
      ledger.getBalance.mockResolvedValue(41);
      ledger.recentEntries.mockResolvedValue([ledgerRow()]);
      events.countByStatus.mockResolvedValue([
        { status: "enriched", count: 5 },
        { status: "dead_letter", count: 1 },
      ]);
      events.listByStatus.mockImplementation(async (_loc, statuses) => {
        // The failure query asks for failed + dead_letter; the recent query asks for all.
        if (statuses.length === 2) return [eventRow({ status: "dead_letter" })];
        return [eventRow({ status: "enriched", detail: null, enriched_at: new Date() })];
      });

      const detail = await service.getLocationStatus("loc_1");

      expect(detail).not.toBeNull();
      expect(detail!.connection.provisionedFieldCount).toBe(2);
      expect(detail!.credits.balance).toBe(41);
      expect(detail!.credits.recent).toEqual([
        {
          id: "led-1",
          amount: -1,
          balanceAfter: 41,
          reason: "enrichment",
          contactId: "ct_1",
          createdAt: new Date("2026-06-20T00:00:00Z"),
        },
      ]);
      expect(detail!.enrichment.counts).toEqual({
        enriched: 5,
        skipped: 0,
        credit_blocked: 0,
        failed: 0,
        dead_letter: 1,
        total: 6,
      });

      // Failures carry the JAK-111 secret-free reason for inspection / requeue.
      expect(detail!.failures).toHaveLength(1);
      expect(detail!.failures[0]).toEqual({
        contactId: "ct_1",
        status: "dead_letter",
        detail: "write-back: GHL 500",
        attemptCount: 3,
        enrichedAt: null,
        failedAt: new Date("2026-06-20T00:00:00Z"),
        updatedAt: new Date("2026-06-20T00:00:00Z"),
      });

      // The failure query targeted exactly failed + dead_letter.
      expect(events.listByStatus).toHaveBeenCalledWith("loc_1", ["failed", "dead_letter"], 20);
    });

    it("NEVER exposes the encrypted API key in the detail payload", async () => {
      connections.findByLocationId.mockResolvedValue(connectionRow());
      customFields.listByLocation.mockResolvedValue([]);
      ledger.getBalance.mockResolvedValue(0);
      ledger.recentEntries.mockResolvedValue([]);
      events.countByStatus.mockResolvedValue([]);
      events.listByStatus.mockResolvedValue([]);

      const detail = await service.getLocationStatus("loc_1");

      const serialized = JSON.stringify(detail);
      expect(serialized).not.toContain("api_key");
      expect(serialized).not.toContain("not-a-real-secret");
    });
  });
});
