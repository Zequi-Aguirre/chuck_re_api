import { mock, MockProxy } from "jest-mock-extended";
import { SkipTraceSettingsService } from "../SkipTraceSettingsService";
import { AppSettingsStore, AppSettingRow } from "../../../data/AppSettingsStore";

/**
 * The admin-editable skip-trace credit cost (JAK-136) — same editable pattern as
 * the JAK-134 conversation settings: DB value wins, code default (3) is the
 * fallback, a bad/blank value falls back to the default (a paid trace can never be
 * silently zeroed), and an edit busts the short-TTL cache. A subclass drives the clock.
 */
describe("SkipTraceSettingsService (JAK-136)", () => {
  let settings: MockProxy<AppSettingsStore>;

  class Clocked extends SkipTraceSettingsService {
    public now = 0;
    protected clock(): number {
      return this.now;
    }
  }

  const row = (value: string): AppSettingRow => ({
    key: SkipTraceSettingsService.CREDIT_COST_KEY,
    value,
    updated_at: new Date("2026-07-03T00:00:00Z"),
    updated_by: "admin_1",
  });

  beforeEach(() => {
    settings = mock<AppSettingsStore>();
  });

  it("defaults to 3 credits when nothing is stored", async () => {
    settings.get.mockResolvedValue(null);
    const svc = new SkipTraceSettingsService(settings);
    expect(await svc.costOfSkipTrace()).toBe(SkipTraceSettingsService.DEFAULT_CREDIT_COST);
    expect(SkipTraceSettingsService.DEFAULT_CREDIT_COST).toBe(3);
  });

  it("prefers a stored positive-integer value", async () => {
    settings.get.mockResolvedValue(row("5"));
    const svc = new SkipTraceSettingsService(settings);
    expect(await svc.costOfSkipTrace()).toBe(5);
  });

  it("falls back to the default for a non-positive-integer stored value", async () => {
    settings.get.mockResolvedValue(row("nonsense"));
    const svc = new SkipTraceSettingsService(settings);
    expect(await svc.costOfSkipTrace()).toBe(3);
  });

  it("caches within the TTL, then re-queries once it expires", async () => {
    settings.get.mockResolvedValue(row("3"));
    const svc = new Clocked(settings);

    expect(await svc.costOfSkipTrace()).toBe(3);
    settings.get.mockResolvedValue(row("9"));
    svc.now = 10_000;
    expect(await svc.costOfSkipTrace()).toBe(3);
    svc.now = 40_000;
    expect(await svc.costOfSkipTrace()).toBe(9);
  });

  it("setCost persists, records the admin, and busts the cache immediately", async () => {
    settings.get.mockResolvedValue(row("3"));
    settings.set.mockResolvedValue(row("7"));
    const svc = new SkipTraceSettingsService(settings);

    await svc.costOfSkipTrace();
    const view = await svc.setCost(7, "admin_1");

    expect(settings.set).toHaveBeenCalledWith(SkipTraceSettingsService.CREDIT_COST_KEY, "7", "admin_1");
    expect(view.isDefault).toBe(false);
    expect(await svc.costOfSkipTrace()).toBe(7);
  });

  it("setCost rejects a zero / non-positive-integer cost", async () => {
    const svc = new SkipTraceSettingsService(settings);
    await expect(svc.setCost(0, "admin_1")).rejects.toThrow();
    await expect(svc.setCost(-1, "admin_1")).rejects.toThrow();
    await expect(svc.setCost(2.5, "admin_1")).rejects.toThrow();
    expect(settings.set).not.toHaveBeenCalled();
  });

  it("resetCost clears the stored value and reverts to the default", async () => {
    settings.delete.mockResolvedValue(true);
    const svc = new SkipTraceSettingsService(settings);

    const view = await svc.resetCost();

    expect(settings.delete).toHaveBeenCalledWith(SkipTraceSettingsService.CREDIT_COST_KEY);
    expect(view.isDefault).toBe(true);
    expect(view.value).toBe(3);
  });
});
