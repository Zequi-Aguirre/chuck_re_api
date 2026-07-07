import { mock, MockProxy } from "jest-mock-extended";
import { AppSettingsStore, AppSettingRow } from "../../../data/AppSettingsStore";
import { OnboardingPromptService } from "../OnboardingPromptService";

/** Subclass to drive the TTL cache deterministically without real time. */
class TestOnboardingPromptService extends OnboardingPromptService {
  public now = 1_000;
  protected clock(): number {
    return this.now;
  }
}

const row = (value: string): AppSettingRow => ({
  key: OnboardingPromptService.KEY,
  value,
  updated_at: new Date("2026-07-07T00:00:00Z"),
  updated_by: "admin-1",
});

describe("OnboardingPromptService (JAK-first-text-welcome)", () => {
  let store: MockProxy<AppSettingsStore>;
  let service: TestOnboardingPromptService;

  beforeEach(() => {
    store = mock<AppSettingsStore>();
    service = new TestOnboardingPromptService(store);
  });

  it("falls back to the code default when nothing is stored", async () => {
    store.get.mockResolvedValue(null);
    expect(await service.getEffectivePrompt()).toBe(OnboardingPromptService.DEFAULT_PROMPT);
    // The default frames the email as a benefit (report emailed to them).
    expect(OnboardingPromptService.DEFAULT_PROMPT.toLowerCase()).toContain("emailed to you");
    expect(OnboardingPromptService.DEFAULT_PROMPT.toLowerCase()).toContain("name and email");
  });

  it("reads a stored admin-edited value keyed onboarding_email_ask_prompt", async () => {
    store.get.mockResolvedValue(row("Tell me your name and email for updates."));
    expect(await service.getEffectivePrompt()).toBe("Tell me your name and email for updates.");
    expect(store.get).toHaveBeenCalledWith("onboarding_email_ask_prompt");
  });

  it("caches within the TTL then re-reads after it expires", async () => {
    store.get.mockResolvedValue(row("v1"));
    await service.getEffectivePrompt();
    await service.getEffectivePrompt();
    expect(store.get).toHaveBeenCalledTimes(1);
    service.now += 31_000;
    await service.getEffectivePrompt();
    expect(store.get).toHaveBeenCalledTimes(2);
  });

  it("getView reports isDefault + edit metadata", async () => {
    store.get.mockResolvedValue(null);
    expect(await service.getView()).toEqual({
      prompt: OnboardingPromptService.DEFAULT_PROMPT,
      isDefault: true,
      updatedAt: null,
      updatedBy: null,
    });

    store.get.mockResolvedValue(row("Custom ask"));
    const view = await service.getView();
    expect(view.prompt).toBe("Custom ask");
    expect(view.isDefault).toBe(false);
    expect(view.updatedBy).toBe("admin-1");
  });

  it("setPrompt persists trimmed value, records the admin, and busts the cache", async () => {
    store.set.mockResolvedValue(row("New ask"));
    const view = await service.setPrompt("  New ask  ", "admin-1");
    expect(store.set).toHaveBeenCalledWith("onboarding_email_ask_prompt", "New ask", "admin-1");
    expect(view).toMatchObject({ prompt: "New ask", isDefault: false });
    // Cached immediately — the next read does not hit the store.
    expect(await service.getEffectivePrompt()).toBe("New ask");
    expect(store.get).not.toHaveBeenCalled();
  });

  it("resetPrompt clears the stored value and reverts to the default", async () => {
    store.delete.mockResolvedValue(true);
    const view = await service.resetPrompt();
    expect(store.delete).toHaveBeenCalledWith("onboarding_email_ask_prompt");
    expect(view).toEqual({
      prompt: OnboardingPromptService.DEFAULT_PROMPT,
      isDefault: true,
      updatedAt: null,
      updatedBy: null,
    });
  });
});
