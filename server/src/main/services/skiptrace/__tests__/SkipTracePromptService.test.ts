import { mock, MockProxy } from "jest-mock-extended";
import { SkipTracePromptService } from "../SkipTracePromptService";
import { AppSettingsStore, AppSettingRow } from "../../../data/AppSettingsStore";

/**
 * The admin-editable skip-trace prompt (JAK-136) — same editable pattern as the
 * JAK-135 orchestrator prompt: DB value wins, code default is the fallback, edits
 * bust the short-TTL cache immediately. A test subclass drives the clock.
 */
describe("SkipTracePromptService (JAK-136)", () => {
  let settings: MockProxy<AppSettingsStore>;

  class Clocked extends SkipTracePromptService {
    public now = 0;
    protected clock(): number {
      return this.now;
    }
  }

  const row = (value: string): AppSettingRow => ({
    key: SkipTracePromptService.KEY,
    value,
    updated_at: new Date("2026-07-03T00:00:00Z"),
    updated_by: "admin_1",
  });

  beforeEach(() => {
    settings = mock<AppSettingsStore>();
  });

  it("returns the code default when nothing is stored", async () => {
    settings.get.mockResolvedValue(null);
    const svc = new SkipTracePromptService(settings);
    expect(await svc.getEffectivePrompt()).toBe(SkipTracePromptService.DEFAULT_PROMPT);
  });

  it("prefers a stored admin value over the default", async () => {
    settings.get.mockResolvedValue(row("CUSTOM SKIP TRACE PROMPT"));
    const svc = new SkipTracePromptService(settings);
    expect(await svc.getEffectivePrompt()).toBe("CUSTOM SKIP TRACE PROMPT");
  });

  it("caches within the TTL, then re-queries once it expires", async () => {
    settings.get.mockResolvedValue(row("V1"));
    const svc = new Clocked(settings);

    expect(await svc.getEffectivePrompt()).toBe("V1");
    settings.get.mockResolvedValue(row("V2"));
    svc.now = 10_000;
    expect(await svc.getEffectivePrompt()).toBe("V1");
    svc.now = 40_000;
    expect(await svc.getEffectivePrompt()).toBe("V2");
  });

  it("setPrompt persists, records the admin, and busts the cache immediately", async () => {
    settings.get.mockResolvedValue(row("OLD"));
    settings.set.mockResolvedValue(row("NEW"));
    const svc = new SkipTracePromptService(settings);

    await svc.getEffectivePrompt();
    const view = await svc.setPrompt("NEW", "admin_1");

    expect(settings.set).toHaveBeenCalledWith(SkipTracePromptService.KEY, "NEW", "admin_1");
    expect(view.isDefault).toBe(false);
    expect(await svc.getEffectivePrompt()).toBe("NEW");
  });

  it("resetPrompt clears the stored value and reverts to the default", async () => {
    settings.delete.mockResolvedValue(true);
    const svc = new SkipTracePromptService(settings);

    const view = await svc.resetPrompt();

    expect(settings.delete).toHaveBeenCalledWith(SkipTracePromptService.KEY);
    expect(view.isDefault).toBe(true);
    expect(view.prompt).toBe(SkipTracePromptService.DEFAULT_PROMPT);
  });
});
