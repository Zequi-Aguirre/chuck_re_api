import { mock, MockProxy } from "jest-mock-extended";
import { GhlApiClient, GhlConnectionUnavailableError } from "../../api/GhlApiClient";
import { GhlCustomField } from "../../api/GhlApiTypes";
import { GhlConnectionService } from "../../connections/GhlConnectionService";
import { GhlConnection } from "../../connections/GhlConnectionTypes";
import { GhlCustomFieldRow, GhlCustomFieldStore } from "../GhlCustomFieldStore";
import {
  GhlInstallLifecycleService,
  WELCOME_NOTE_BODY,
} from "../GhlInstallLifecycleService";
import { JAKE_CUSTOM_FIELDS } from "../JakeCustomFields";

const conn = (over: Partial<GhlConnection> = {}): GhlConnection => ({
  id: "11111111-1111-1111-1111-111111111111",
  locationId: "loc_1",
  name: null,
  apiKey: "unit-test-plaintext-key",
  baseUrl: "https://services.leadconnectorhq.com",
  phoneNumbers: [],
  status: "active",
  autoEnrichmentEnabled: false,
  createdAt: new Date("2026-07-01T00:00:00Z"),
  updatedAt: new Date("2026-07-01T00:00:00Z"),
  ...over,
});

/** A recorded row for a given canonical key (only the fields the service reads). */
const row = (jakeKey: string, over: Partial<GhlCustomFieldRow> = {}): GhlCustomFieldRow => ({
  id: `row-${jakeKey}`,
  location_id: "loc_1",
  jake_field_key: jakeKey,
  ghl_field_id: `cf_${jakeKey}`,
  ghl_field_key: `contact.${jakeKey}`,
  name: jakeKey,
  data_type: "TEXT",
  created_at: new Date("2026-07-01T00:00:00Z"),
  modified_at: new Date("2026-07-01T00:00:00Z"),
  deleted_at: null,
  ...over,
});

describe("GhlInstallLifecycleService", () => {
  let client: MockProxy<GhlApiClient>;
  let connections: MockProxy<GhlConnectionService>;
  let fields: MockProxy<GhlCustomFieldStore>;
  let service: GhlInstallLifecycleService;

  beforeEach(() => {
    client = mock<GhlApiClient>();
    connections = mock<GhlConnectionService>();
    fields = mock<GhlCustomFieldStore>();
    service = new GhlInstallLifecycleService(client, connections, fields);

    // Sensible defaults: active connection, nothing recorded, nothing remote,
    // and every create succeeds by echoing back an id derived from the fieldKey.
    connections.getByLocationId.mockResolvedValue(conn());
    connections.updateConnection.mockResolvedValue(conn());
    fields.listByLocation.mockResolvedValue([]);
    client.listCustomFields.mockResolvedValue([]);
    client.createCustomField.mockImplementation(async (_loc, input) => ({
      id: `cf_${input.fieldKey}`,
      name: input.name,
      fieldKey: `contact.${input.fieldKey}`,
      dataType: input.dataType,
    }));
    fields.insert.mockImplementation(async (r) => row(r.jake_field_key, r));
  });

  describe("install — provisioning", () => {
    it("creates and records every canonical field on a fresh install", async () => {
      const result = await service.install("loc_1");

      expect(client.createCustomField).toHaveBeenCalledTimes(JAKE_CUSTOM_FIELDS.length);
      expect(fields.insert).toHaveBeenCalledTimes(JAKE_CUSTOM_FIELDS.length);
      expect(result.fields.map((f) => f.outcome)).toEqual(
        JAKE_CUSTOM_FIELDS.map(() => "created")
      );
      // Requested the canonical key as the GHL fieldKey.
      expect(client.createCustomField).toHaveBeenCalledWith("loc_1", {
        name: JAKE_CUSTOM_FIELDS[0].name,
        dataType: JAKE_CUSTOM_FIELDS[0].dataType,
        fieldKey: JAKE_CUSTOM_FIELDS[0].key,
      });
    });

    it("persists the GHL-assigned id per field for write-back", async () => {
      await service.install("loc_1");

      const inserted = fields.insert.mock.calls.map(([r]) => r);
      const first = inserted.find((r) => r.jake_field_key === "jake_owner_name");
      expect(first?.ghl_field_id).toBe("cf_jake_owner_name");
      expect(first?.ghl_field_key).toBe("contact.jake_owner_name");
    });
  });

  describe("install — idempotency (re-install must not duplicate)", () => {
    it("skips fields we already recorded and creates none", async () => {
      fields.listByLocation.mockResolvedValue(
        JAKE_CUSTOM_FIELDS.map((d) => row(d.key))
      );

      const result = await service.install("loc_1");

      expect(client.createCustomField).not.toHaveBeenCalled();
      expect(fields.insert).not.toHaveBeenCalled();
      expect(result.fields.every((f) => f.outcome === "existing")).toBe(true);
    });

    it("adopts a GHL field that already exists by key instead of duplicating it", async () => {
      const remote: GhlCustomField = {
        id: "cf_preexisting",
        name: "Jake Owner Name",
        fieldKey: "contact.jake_owner_name", // GHL-prefixed form
      };
      client.listCustomFields.mockResolvedValue([remote]);

      const result = await service.install("loc_1");

      // The owner-name field is adopted (recorded, not created); the rest created.
      const owner = result.fields.find((f) => f.key === "jake_owner_name");
      expect(owner?.outcome).toBe("adopted");
      expect(owner?.row?.ghl_field_id).toBe("cf_preexisting");
      expect(client.createCustomField).toHaveBeenCalledTimes(
        JAKE_CUSTOM_FIELDS.length - 1
      );
      expect(client.createCustomField).not.toHaveBeenCalledWith(
        "loc_1",
        expect.objectContaining({ fieldKey: "jake_owner_name" })
      );
    });

    it("mixes recorded + remote + new in one pass", async () => {
      fields.listByLocation.mockResolvedValue([row("jake_owner_name")]);
      client.listCustomFields.mockResolvedValue([
        { id: "cf_remote", name: "x", fieldKey: "contact.jake_last_sale_price" },
      ]);

      const result = await service.install("loc_1");

      const byKey = new Map(result.fields.map((f) => [f.key, f.outcome]));
      expect(byKey.get("jake_owner_name")).toBe("existing");
      expect(byKey.get("jake_last_sale_price")).toBe("adopted");
      expect(byKey.get("jake_mortgage_amount")).toBe("created");
    });
  });

  describe("install — reactivation on re-install", () => {
    it("reactivates an inactive connection before provisioning writes", async () => {
      connections.getByLocationId.mockResolvedValue(conn({ status: "inactive" }));

      await service.install("loc_1");

      expect(connections.updateConnection).toHaveBeenCalledWith("loc_1", {
        status: "active",
      });
    });

    it("leaves an already-active connection untouched", async () => {
      await service.install("loc_1");
      expect(connections.updateConnection).not.toHaveBeenCalled();
    });

    it("throws when no connection exists for the location", async () => {
      connections.getByLocationId.mockResolvedValue(null);
      await expect(service.install("loc_1")).rejects.toBeInstanceOf(
        GhlConnectionUnavailableError
      );
      expect(client.createCustomField).not.toHaveBeenCalled();
    });
  });

  describe("install — welcome note", () => {
    it("drops the welcome note on the given contact and returns its id", async () => {
      client.createNote.mockResolvedValue({ id: "note_1", body: WELCOME_NOTE_BODY });

      const result = await service.install("loc_1", { welcomeContactId: "ct_9" });

      expect(client.createNote).toHaveBeenCalledWith("loc_1", "ct_9", WELCOME_NOTE_BODY);
      expect(result.welcomeNoteId).toBe("note_1");
    });

    it("skips the welcome note when no target contact is provided", async () => {
      const result = await service.install("loc_1");
      expect(client.createNote).not.toHaveBeenCalled();
      expect(result.welcomeNoteId).toBeNull();
    });

    it("returns a null note id when the write is skipped off-prod", async () => {
      client.createNote.mockResolvedValue(null); // dev-safety skip in the client
      const result = await service.install("loc_1", { welcomeContactId: "ct_9" });
      expect(result.welcomeNoteId).toBeNull();
    });
  });

  describe("install — off-prod dev safety", () => {
    it("records nothing when the client skips creates off-prod", async () => {
      client.createCustomField.mockResolvedValue(null); // SPEC §8 dev echo/skip

      const result = await service.install("loc_1");

      expect(fields.insert).not.toHaveBeenCalled();
      expect(result.fields.every((f) => f.outcome === "skipped")).toBe(true);
    });
  });

  describe("uninstall", () => {
    it("marks the connection inactive and reports success", async () => {
      connections.updateConnection.mockResolvedValue(conn({ status: "inactive" }));

      expect(await service.uninstall("loc_1")).toBe(true);
      expect(connections.updateConnection).toHaveBeenCalledWith("loc_1", {
        status: "inactive",
      });
    });

    it("reports false for an unknown location", async () => {
      connections.updateConnection.mockResolvedValue(null);
      expect(await service.uninstall("missing")).toBe(false);
    });
  });
});
