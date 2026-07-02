import { mock, MockProxy } from "jest-mock-extended";
import { PropertyReportPromptService } from "../PropertyReportPromptService";
import { AppSettingsStore, AppSettingRow } from "../../data/AppSettingsStore";

/**
 * JAK-131 — the editable STYLE prompt store/service. Pins: default fallback when
 * nothing is stored, the stored value wins when present, reads are cached, and an
 * edit/reset busts the cache immediately so the next report reflects it.
 */
const KEY = PropertyReportPromptService.KEY;
const DEFAULT = PropertyReportPromptService.DEFAULT_STYLE_PROMPT;

const row = (over: Partial<AppSettingRow> = {}): AppSettingRow => ({
  key: KEY,
  value: "STORED STYLE",
  updated_at: new Date("2026-07-02T00:00:00Z"),
  updated_by: "admin-1",
  ...over,
});

describe("PropertyReportPromptService", () => {
  let store: MockProxy<AppSettingsStore>;
  let svc: PropertyReportPromptService;

  beforeEach(() => {
    store = mock<AppSettingsStore>();
    svc = new PropertyReportPromptService(store);
  });

  it("falls back to the code default when nothing is stored", async () => {
    store.get.mockResolvedValue(null);
    expect(await svc.getEffectivePrompt()).toBe(DEFAULT);
  });

  it("returns the stored value when present", async () => {
    store.get.mockResolvedValue(row({ value: "STORED STYLE" }));
    expect(await svc.getEffectivePrompt()).toBe("STORED STYLE");
  });

  it("caches reads within the TTL (one DB hit)", async () => {
    store.get.mockResolvedValue(row({ value: "STORED STYLE" }));
    await svc.getEffectivePrompt();
    await svc.getEffectivePrompt();
    expect(store.get).toHaveBeenCalledTimes(1);
  });

  it("busts the cache on setPrompt so the next read reflects the edit", async () => {
    store.get.mockResolvedValue(null);
    expect(await svc.getEffectivePrompt()).toBe(DEFAULT); // caches default
    store.set.mockResolvedValue(row({ value: "NEW STYLE", updated_by: "admin-9" }));

    const view = await svc.setPrompt("NEW STYLE", "admin-9");

    expect(view).toMatchObject({ prompt: "NEW STYLE", isDefault: false, updatedBy: "admin-9" });
    // No extra store.get — the write updated the cache in place.
    expect(await svc.getEffectivePrompt()).toBe("NEW STYLE");
    expect(store.get).toHaveBeenCalledTimes(1);
    expect(store.set).toHaveBeenCalledWith(KEY, "NEW STYLE", "admin-9");
  });

  it("resetPrompt clears storage and reverts to the default", async () => {
    store.delete.mockResolvedValue(true);
    const view = await svc.resetPrompt();
    expect(view).toEqual({ prompt: DEFAULT, isDefault: true, updatedAt: null, updatedBy: null });
    expect(store.delete).toHaveBeenCalledWith(KEY);

    // The next effective read returns the default from cache (no DB call needed).
    expect(await svc.getEffectivePrompt()).toBe(DEFAULT);
  });

  it("getView reports isDefault + edit metadata", async () => {
    store.get.mockResolvedValueOnce(null);
    expect(await svc.getView()).toMatchObject({ prompt: DEFAULT, isDefault: true, updatedBy: null });

    store.get.mockResolvedValueOnce(row({ value: "CUSTOM", updated_by: "admin-2" }));
    const custom = await svc.getView();
    expect(custom).toMatchObject({ prompt: "CUSTOM", isDefault: false, updatedBy: "admin-2" });
  });

  it("treats a blank stored value as unset (uses the default)", async () => {
    store.get.mockResolvedValue(row({ value: "   " }));
    expect(await svc.getEffectivePrompt()).toBe(DEFAULT);
  });
});
