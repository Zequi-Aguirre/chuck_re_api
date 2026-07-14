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

  it("default prompt names the JAK-132 Financials + Distress/Lien sections and rules", () => {
    // The report must be told to surface money + distress signals, and to treat
    // liens as Yes/No FLAGS (never a dollar amount) with false/absent flags omitted.
    expect(DEFAULT).toContain("Financials");
    expect(DEFAULT).toContain("openMortgageBalance");
    expect(DEFAULT).toContain("estimatedMortgagePayment");
    expect(DEFAULT).toContain("estimatedEquity");
    expect(DEFAULT).toContain("Distress / Liens");
    expect(DEFAULT).toMatch(/foreclosure/i);
    expect(DEFAULT).toMatch(/pre-foreclosure/i);
    expect(DEFAULT).toMatch(/tax lien/i);
    expect(DEFAULT).toMatch(/judgment/i);
    expect(DEFAULT).toMatch(/FLAGS, not amounts/);
    expect(DEFAULT).toContain("No liens or foreclosure on record");
  });

  describe("JAK-132 reseed migration (real-timestamp forward migration)", () => {
    const fs = require("fs");
    const path = require("path");

    // JAK-133: the reseed lives in a real-timestamp forward migration (never a
    // hand-numbered filename, never an edit to the already-applied 000004 seed).
    // Resolve it by its stable suffix so a future re-timestamp doesn't break this.
    const migrationsDir = path.join(__dirname, "../../../../../postgres/migrations");
    const reseedFile = fs
      .readdirSync(migrationsDir)
      .find((f: string) => f.endsWith(".do._update_property_report_prompt_jak132.sql"));
    if (!reseedFile) {
      throw new Error("JAK-132 reseed migration not found in postgres/migrations");
    }
    const reseedSql: string = fs.readFileSync(
      path.join(migrationsDir, reseedFile),
      "utf8"
    );

    // Pull the two dollar-quoted blocks out of the real migration: the NEW value
    // it SETs, and the OLD default it guards on in the WHERE clause.
    const block = (tag: string): string => {
      const m = reseedSql.match(new RegExp(`\\$${tag}\\$([\\s\\S]*?)\\$${tag}\\$`));
      if (!m) throw new Error(`missing $${tag}$ block in reseed migration`);
      return m[1];
    };
    const NEW_VALUE = block("new");
    const OLD_DEFAULT = block("old");

    // Mirror the migration's semantics: it rewrites the row to NEW_VALUE ONLY
    // when the stored value still equals the untouched OLD_DEFAULT.
    const applyReseed = (stored: string): string =>
      stored === OLD_DEFAULT ? NEW_VALUE : stored;

    it("SETs exactly the current code default (source of truth, no drift)", () => {
      expect(NEW_VALUE).toBe(DEFAULT);
    });

    it("guards on the OLD default VALUE — which is the pre-JAK-132 prompt", () => {
      // The guard is value-based (not updated_by), so it is safe regardless of
      // how the row's author column was set.
      expect(reseedSql).toMatch(/where\s+key\s*=\s*'property_report_prompt'/i);
      expect(reseedSql).toContain("and value = $old$");
      // Sanity: the OLD default is genuinely the old one — no JAK-132 sections.
      expect(OLD_DEFAULT).not.toBe(NEW_VALUE);
      expect(OLD_DEFAULT).not.toContain("Financials");
      expect(OLD_DEFAULT).not.toContain("Distress / Liens");
    });

    it("overwrites an UNTOUCHED old-default row with the new default", () => {
      expect(applyReseed(OLD_DEFAULT)).toBe(DEFAULT);
    });

    it("leaves an admin-CUSTOMIZED row untouched", () => {
      const customized = "SUPER TERSE MODE: one line only, no sections.";
      expect(applyReseed(customized)).toBe(customized);
    });

    it("is idempotent — re-running over an already-migrated row is a no-op", () => {
      expect(applyReseed(NEW_VALUE)).toBe(NEW_VALUE);
    });
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
