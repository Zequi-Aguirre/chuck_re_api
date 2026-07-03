import { mock, MockProxy } from "jest-mock-extended";
import {
  ConversationSettingsService,
  parsePositiveInt,
} from "../ConversationSettingsService";
import { AppSettingsStore, AppSettingRow } from "../../../data/AppSettingsStore";

/**
 * JAK-134 — the two admin-configurable conversation settings, backed by the same
 * app_settings KV store as the JAK-131 prompt. Pins: code defaults when unset,
 * stored value wins, a bad stored value falls back to the default (never breaks
 * the flow), reads are cached, and a save busts the cache.
 */
const CTX_KEY = ConversationSettingsService.CONTEXT_WINDOW_KEY;
const WIN_KEY = ConversationSettingsService.FREE_RESERVE_WINDOW_DAYS_KEY;

const row = (value: string, over: Partial<AppSettingRow> = {}): AppSettingRow => ({
  key: CTX_KEY,
  value,
  updated_at: new Date("2026-07-03T00:00:00Z"),
  updated_by: "admin-1",
  ...over,
});

/** Subclass with a drivable clock so the TTL is deterministic. */
class TestSettings extends ConversationSettingsService {
  public now = 0;
  protected clock(): number {
    return this.now;
  }
}

describe("ConversationSettingsService", () => {
  let store: MockProxy<AppSettingsStore>;
  let svc: TestSettings;

  beforeEach(() => {
    store = mock<AppSettingsStore>();
    svc = new TestSettings(store);
  });

  it("defaults to 10 / 5 when nothing is stored", async () => {
    store.get.mockResolvedValue(null);
    expect(await svc.contextWindowSize()).toBe(10);
    expect(await svc.freeReserveWindowDays()).toBe(5);
    expect(ConversationSettingsService.DEFAULT_CONTEXT_WINDOW_SIZE).toBe(10);
    expect(ConversationSettingsService.DEFAULT_FREE_RESERVE_WINDOW_DAYS).toBe(5);
  });

  it("uses the stored value when present", async () => {
    store.get.mockImplementation(async (key) =>
      key === CTX_KEY ? row("25") : row("14", { key: WIN_KEY })
    );
    expect(await svc.contextWindowSize()).toBe(25);
    expect(await svc.freeReserveWindowDays()).toBe(14);
  });

  it("falls back to the default when the stored value is not a positive integer", async () => {
    for (const bad of ["", "  ", "0", "-3", "abc", "5.5", "5 days"]) {
      store.get.mockResolvedValue(row(bad));
      svc.now += 60_000; // bust the short-TTL cache between cases
      expect(await svc.contextWindowSize()).toBe(10);
    }
  });

  it("caches a read within the TTL, then re-queries once it expires", async () => {
    store.get.mockResolvedValue(row("7"));

    expect(await svc.contextWindowSize()).toBe(7);
    expect(await svc.contextWindowSize()).toBe(7); // served from cache
    expect(store.get).toHaveBeenCalledTimes(1);

    svc.now += 60_000; // past the 30s TTL
    store.get.mockResolvedValue(row("9"));
    expect(await svc.contextWindowSize()).toBe(9);
    expect(store.get).toHaveBeenCalledTimes(2);
  });

  it("set() persists and busts the cache immediately", async () => {
    store.set.mockResolvedValue(row("30", { updated_by: "admin-9" }));
    const view = await svc.setContextWindowSize(30, "admin-9");

    expect(store.set).toHaveBeenCalledWith(CTX_KEY, "30", "admin-9");
    expect(view).toMatchObject({ value: 30, isDefault: false, updatedBy: "admin-9" });
    // The very next read reflects the edit without a new store.get.
    expect(await svc.contextWindowSize()).toBe(30);
    expect(store.get).not.toHaveBeenCalled();
  });

  it("set() rejects a non-positive-integer value", async () => {
    await expect(svc.setFreeReserveWindowDays(0, null)).rejects.toThrow();
    await expect(svc.setFreeReserveWindowDays(-1, null)).rejects.toThrow();
    await expect(svc.setFreeReserveWindowDays(2.5, null)).rejects.toThrow();
    expect(store.set).not.toHaveBeenCalled();
  });
});

describe("parsePositiveInt", () => {
  it("accepts positive integers, rejects everything else", () => {
    expect(parsePositiveInt("10")).toBe(10);
    expect(parsePositiveInt(" 5 ")).toBe(5);
    expect(parsePositiveInt("0")).toBeNull();
    expect(parsePositiveInt("-1")).toBeNull();
    expect(parsePositiveInt("1.5")).toBeNull();
    expect(parsePositiveInt("abc")).toBeNull();
    expect(parsePositiveInt("")).toBeNull();
    expect(parsePositiveInt(null)).toBeNull();
    expect(parsePositiveInt(undefined)).toBeNull();
  });
});
