import { mock, MockProxy } from "jest-mock-extended";
import { CompsSettingsService } from "../CompsSettingsService";
import { DEFAULT_COMP_PARAMS } from "../CompsTypes";
import { AppSettingsStore, AppSettingRow } from "../../../data/AppSettingsStore";

/**
 * The admin-editable comps CREDIT COST and DEFAULT PARAMETERS (JAK-137) — same
 * editable pattern as the JAK-136 skip-trace settings: DB value wins, code default
 * is the fallback, a bad/blank cost falls back to the default (a paid pull can never
 * be silently zeroed), stored params are always clamped, and an edit busts the
 * short-TTL cache. A subclass drives the clock.
 */
describe("CompsSettingsService (JAK-137)", () => {
  let settings: MockProxy<AppSettingsStore>;

  class Clocked extends CompsSettingsService {
    public now = 0;
    protected clock(): number {
      return this.now;
    }
  }

  const costRow = (value: string): AppSettingRow => ({
    key: CompsSettingsService.CREDIT_COST_KEY,
    value,
    updated_at: new Date("2026-07-03T00:00:00Z"),
    updated_by: "admin_1",
  });

  const paramsRow = (value: string): AppSettingRow => ({
    key: CompsSettingsService.PARAMS_KEY,
    value,
    updated_at: new Date("2026-07-03T00:00:00Z"),
    updated_by: "admin_1",
  });

  beforeEach(() => {
    settings = mock<AppSettingsStore>();
  });

  describe("credit cost", () => {
    it("defaults to 3 credits when nothing is stored", async () => {
      settings.get.mockResolvedValue(null);
      const svc = new CompsSettingsService(settings);
      expect(await svc.costOfComps()).toBe(CompsSettingsService.DEFAULT_CREDIT_COST);
      expect(CompsSettingsService.DEFAULT_CREDIT_COST).toBe(3);
    });

    it("prefers a stored positive-integer value", async () => {
      settings.get.mockResolvedValue(costRow("5"));
      const svc = new CompsSettingsService(settings);
      expect(await svc.costOfComps()).toBe(5);
    });

    it("falls back to the default for a non-positive-integer stored value", async () => {
      settings.get.mockResolvedValue(costRow("nonsense"));
      const svc = new CompsSettingsService(settings);
      expect(await svc.costOfComps()).toBe(3);
    });

    it("caches within the TTL, then re-queries once it expires", async () => {
      settings.get.mockResolvedValue(costRow("3"));
      const svc = new Clocked(settings);

      expect(await svc.costOfComps()).toBe(3);
      settings.get.mockResolvedValue(costRow("9"));
      svc.now = 10_000;
      expect(await svc.costOfComps()).toBe(3);
      svc.now = 40_000;
      expect(await svc.costOfComps()).toBe(9);
    });

    it("setCost persists, records the admin, and busts the cache immediately", async () => {
      settings.get.mockResolvedValue(costRow("3"));
      settings.set.mockResolvedValue(costRow("7"));
      const svc = new CompsSettingsService(settings);

      await svc.costOfComps();
      const view = await svc.setCost(7, "admin_1");

      expect(settings.set).toHaveBeenCalledWith(CompsSettingsService.CREDIT_COST_KEY, "7", "admin_1");
      expect(view.isDefault).toBe(false);
      expect(await svc.costOfComps()).toBe(7);
    });

    it("setCost rejects a zero / non-positive-integer cost", async () => {
      const svc = new CompsSettingsService(settings);
      await expect(svc.setCost(0, "admin_1")).rejects.toThrow();
      await expect(svc.setCost(-1, "admin_1")).rejects.toThrow();
      await expect(svc.setCost(2.5, "admin_1")).rejects.toThrow();
      expect(settings.set).not.toHaveBeenCalled();
    });

    it("resetCost clears the stored value and reverts to the default", async () => {
      settings.delete.mockResolvedValue(true);
      const svc = new CompsSettingsService(settings);

      const view = await svc.resetCost();

      expect(settings.delete).toHaveBeenCalledWith(CompsSettingsService.CREDIT_COST_KEY);
      expect(view.isDefault).toBe(true);
      expect(view.value).toBe(3);
    });
  });

  describe("default parameters", () => {
    it("returns the code defaults when nothing is stored", async () => {
      settings.get.mockResolvedValue(null);
      const svc = new CompsSettingsService(settings);
      expect(await svc.defaultParams()).toEqual(DEFAULT_COMP_PARAMS);
    });

    it("prefers a stored parameter-set, filling gaps from the default", async () => {
      settings.get.mockResolvedValue(paramsRow(JSON.stringify({ radiusMiles: 2, count: 3 })));
      const svc = new CompsSettingsService(settings);
      expect(await svc.defaultParams()).toEqual({ ...DEFAULT_COMP_PARAMS, radiusMiles: 2, count: 3 });
    });

    it("clamps a stored parameter-set that is out of range", async () => {
      settings.get.mockResolvedValue(paramsRow(JSON.stringify({ radiusMiles: 500, count: 999 })));
      const svc = new CompsSettingsService(settings);
      const params = await svc.defaultParams();
      expect(params.radiusMiles).toBe(10);
      expect(params.count).toBe(10);
    });

    it("falls back to the default for a corrupt stored value", async () => {
      settings.get.mockResolvedValue(paramsRow("not json"));
      const svc = new CompsSettingsService(settings);
      expect(await svc.defaultParams()).toEqual(DEFAULT_COMP_PARAMS);
    });

    it("setParams clamps, persists JSON, records the admin, and busts the cache", async () => {
      settings.get.mockResolvedValue(null);
      settings.set.mockResolvedValue(paramsRow("{}"));
      const svc = new CompsSettingsService(settings);

      await svc.defaultParams();
      const view = await svc.setParams({ ...DEFAULT_COMP_PARAMS, radiusMiles: 500, count: 3 }, "admin_1");

      // Clamped before persisting (radius 500 → 10).
      expect(settings.set).toHaveBeenCalledWith(
        CompsSettingsService.PARAMS_KEY,
        JSON.stringify({ ...DEFAULT_COMP_PARAMS, radiusMiles: 10, count: 3 }),
        "admin_1"
      );
      expect(view.isDefault).toBe(false);
      expect(view.params.radiusMiles).toBe(10);
      expect(await svc.defaultParams()).toEqual({ ...DEFAULT_COMP_PARAMS, radiusMiles: 10, count: 3 });
    });

    it("resetParams clears the stored value and reverts to the default", async () => {
      settings.delete.mockResolvedValue(true);
      const svc = new CompsSettingsService(settings);

      const view = await svc.resetParams();

      expect(settings.delete).toHaveBeenCalledWith(CompsSettingsService.PARAMS_KEY);
      expect(view.isDefault).toBe(true);
      expect(view.params).toEqual(DEFAULT_COMP_PARAMS);
    });
  });
});
