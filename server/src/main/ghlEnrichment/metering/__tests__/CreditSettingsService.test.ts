import { mock, MockProxy } from "jest-mock-extended";
import { AppSettingsStore, AppSettingRow } from "../../../data/AppSettingsStore";
import { CreditSettingsService, parseNonNegativeInt } from "../CreditSettingsService";

const row = (value: string): AppSettingRow => ({
  key: "k",
  value,
  updated_at: new Date("2026-07-06T00:00:00Z"),
  updated_by: "admin-1",
});

/** A test subclass with a driveable clock so the TTL cache is deterministic. */
class TestCreditSettings extends CreditSettingsService {
  public now = 0;
  protected clock(): number {
    return this.now;
  }
}

describe("parseNonNegativeInt", () => {
  it("accepts 0 (unlike parsePositiveInt) and positive integers", () => {
    expect(parseNonNegativeInt("0")).toBe(0);
    expect(parseNonNegativeInt("10")).toBe(10);
  });
  it("rejects blanks, negatives, and non-integers", () => {
    expect(parseNonNegativeInt(null)).toBeNull();
    expect(parseNonNegativeInt("")).toBeNull();
    expect(parseNonNegativeInt("-1")).toBeNull();
    expect(parseNonNegativeInt("2.5")).toBeNull();
    expect(parseNonNegativeInt("ten")).toBeNull();
  });
});

describe("CreditSettingsService", () => {
  let store: MockProxy<AppSettingsStore>;
  let service: TestCreditSettings;

  beforeEach(() => {
    store = mock<AppSettingsStore>();
    service = new TestCreditSettings(store);
  });

  describe("default grants", () => {
    it("falls back to the code defaults (100/10/10) when unset", async () => {
      store.get.mockResolvedValue(null);
      expect(await service.defaultGrant("report")).toBe(100);
      expect(await service.defaultGrant("skiptrace")).toBe(10);
      expect(await service.defaultGrant("comps")).toBe(10);
    });

    it("reads a stored value keyed default_<type>_credits", async () => {
      store.get.mockImplementation(async (key) =>
        key === "default_skiptrace_credits" ? row("25") : null
      );
      expect(await service.defaultGrant("skiptrace")).toBe(25);
      expect(store.get).toHaveBeenCalledWith("default_skiptrace_credits");
    });

    it("honors a stored 0 (a paid feature can start empty)", async () => {
      store.get.mockResolvedValue(row("0"));
      expect(await service.defaultGrant("comps")).toBe(0);
    });

    it("rejects a non-negative integer on write", async () => {
      await expect(service.setDefaultGrant("comps", -1, "admin-1")).rejects.toThrow();
    });

    it("caches within the TTL then re-reads after it expires", async () => {
      store.get.mockResolvedValue(row("42"));
      expect(await service.defaultGrant("report")).toBe(42);
      expect(await service.defaultGrant("report")).toBe(42);
      expect(store.get).toHaveBeenCalledTimes(1);
      service.now += 31_000;
      await service.defaultGrant("report");
      expect(store.get).toHaveBeenCalledTimes(2);
    });
  });

  describe("out-of-credits messages", () => {
    it("falls back to the emoji-free code defaults when unset", async () => {
      store.get.mockResolvedValue(null);
      expect(await service.outOfCreditsMessage("comps")).toBe(
        "You're out of comps credits. To get more, contact an admin."
      );
    });

    it("does NOT embed the footer (the sender appends it)", async () => {
      store.get.mockResolvedValue(null);
      const msg = await service.outOfCreditsMessage("report");
      expect(msg).not.toContain("GoTextJake.com");
    });

    it("reads a stored non-blank message keyed out_of_credits_message_<type>", async () => {
      store.get.mockImplementation(async (key) =>
        key === "out_of_credits_message_comps" ? row("Buy comps at example.com") : null
      );
      expect(await service.outOfCreditsMessage("comps")).toBe("Buy comps at example.com");
    });

    it("falls back to the default when the stored value is blank", async () => {
      store.get.mockResolvedValue(row("   "));
      expect(await service.outOfCreditsMessage("skiptrace")).toBe(
        "You're out of skip-trace credits. To get more, contact an admin."
      );
    });

    it("rejects an empty message on write", async () => {
      await expect(service.setMessage("report", "   ", "admin-1")).rejects.toThrow();
    });
  });
});
