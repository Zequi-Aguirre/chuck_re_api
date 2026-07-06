import { mock, MockProxy } from "jest-mock-extended";
import { CompsSelectionPromptService } from "../CompsSelectionPromptService";
import { AppSettingsStore, AppSettingRow } from "../../../data/AppSettingsStore";

/**
 * JAK-164 — the admin-editable comps SELECTION prompt: same editable pattern as the
 * JAK-137 comps STYLE prompt (DB value wins, code default is the fallback, edits bust
 * the short-TTL cache immediately). A test subclass drives the clock.
 */
describe("CompsSelectionPromptService (JAK-164)", () => {
  let settings: MockProxy<AppSettingsStore>;

  class Clocked extends CompsSelectionPromptService {
    public now = 0;
    protected clock(): number {
      return this.now;
    }
  }

  const row = (value: string): AppSettingRow => ({
    key: CompsSelectionPromptService.KEY,
    value,
    updated_at: new Date("2026-07-06T00:00:00Z"),
    updated_by: "admin_1",
  });

  beforeEach(() => {
    settings = mock<AppSettingsStore>();
  });

  it("returns the code default when nothing is stored", async () => {
    settings.get.mockResolvedValue(null);
    const svc = new CompsSelectionPromptService(settings);
    expect(await svc.getEffectivePrompt()).toBe(CompsSelectionPromptService.DEFAULT_PROMPT);
  });

  it("prefers a stored admin value over the default", async () => {
    settings.get.mockResolvedValue(row("CUSTOM SELECTION HEURISTICS"));
    const svc = new CompsSelectionPromptService(settings);
    expect(await svc.getEffectivePrompt()).toBe("CUSTOM SELECTION HEURISTICS");
  });

  it("getView reports default vs customized with the edit metadata", async () => {
    settings.get.mockResolvedValueOnce(null);
    const svc = new CompsSelectionPromptService(settings);
    expect(await svc.getView()).toMatchObject({ isDefault: true, updatedAt: null, updatedBy: null });

    settings.get.mockResolvedValue(row("EDITED"));
    expect(await svc.getView()).toMatchObject({ isDefault: false, prompt: "EDITED", updatedBy: "admin_1" });
  });

  it("setPrompt persists the trimmed value and caches it immediately (no re-read)", async () => {
    settings.set.mockResolvedValue(row("NEW"));
    const svc = new Clocked(settings);
    const view = await svc.setPrompt("  NEW  ", "admin_1");
    expect(settings.set).toHaveBeenCalledWith(CompsSelectionPromptService.KEY, "NEW", "admin_1");
    expect(view).toMatchObject({ prompt: "NEW", isDefault: false });
    settings.get.mockClear();
    expect(await svc.getEffectivePrompt()).toBe("NEW");
    expect(settings.get).not.toHaveBeenCalled(); // served from cache
  });

  it("resetPrompt clears the stored value and returns to the code default", async () => {
    const svc = new CompsSelectionPromptService(settings);
    const view = await svc.resetPrompt();
    expect(settings.delete).toHaveBeenCalledWith(CompsSelectionPromptService.KEY);
    expect(view).toMatchObject({ prompt: CompsSelectionPromptService.DEFAULT_PROMPT, isDefault: true });
  });

  it("re-reads Postgres only after the cache TTL expires", async () => {
    settings.get.mockResolvedValue(row("A"));
    const svc = new Clocked(settings);
    svc.now = 0;
    expect(await svc.getEffectivePrompt()).toBe("A");
    settings.get.mockResolvedValue(row("B"));
    svc.now = 10_000; // within TTL → still cached
    expect(await svc.getEffectivePrompt()).toBe("A");
    svc.now = 40_000; // past TTL → re-read
    expect(await svc.getEffectivePrompt()).toBe("B");
  });

  it("the default prompt has no emojis (hard rule)", () => {
    expect(CompsSelectionPromptService.DEFAULT_PROMPT).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});
