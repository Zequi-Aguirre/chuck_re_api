import { LlmModelSettingsService, LlmSurface } from "../LlmModelSettingsService";
import { AppSettingsStore, AppSettingRow } from "../../../data/AppSettingsStore";
import { EnvConfig } from "../../../config/envConfig";

/**
 * JAK-143 — each editable-prompt surface can OPTIONALLY pin its own provider+model,
 * stored in app_settings (one JSON row per surface) and resolved against the JAK-141
 * global Doppler default. These tests pin the seam that matters: (a) an unset surface
 * falls back to the exact global default, (b) a stored override resolves to the
 * chosen provider+model, (c) a provider-only override uses that provider's default
 * model, (d) reset clears the override, and (e) a corrupt row degrades to the global
 * default — all WITHOUT a real DB (the store is a fake) and NEVER touching a key.
 */

const KEY: Record<LlmSurface, string> = {
  orchestrator: "llm_model_orchestrator",
  skiptrace: "llm_model_skiptrace",
  comps: "llm_model_comps",
  comps_selection: "llm_model_comps_selection",
  property_report: "llm_model_property_report",
};

const env = (over: Partial<EnvConfig> = {}): EnvConfig =>
  ({
    llmProvider: "openai",
    openAiApiKey: "openai-key",
    anthropicApiKey: "",
    openAiModel: "gpt-4o",
    anthropicModel: "claude-opus-4-8",
    ...over,
  } as unknown as EnvConfig);

/** A tiny in-memory AppSettingsStore fake — no DB, no network. */
class FakeStore {
  private readonly rows = new Map<string, AppSettingRow>();
  seed(key: string, value: string): void {
    this.rows.set(key, { key, value, updated_at: new Date("2026-07-03T00:00:00Z"), updated_by: "admin-1" });
  }
  async get(key: string): Promise<AppSettingRow | null> {
    return this.rows.get(key) ?? null;
  }
  async set(key: string, value: string, updatedBy: string | null): Promise<AppSettingRow> {
    const row: AppSettingRow = { key, value, updated_at: new Date("2026-07-03T01:00:00Z"), updated_by: updatedBy };
    this.rows.set(key, row);
    return row;
  }
  async delete(key: string): Promise<boolean> {
    return this.rows.delete(key);
  }
}

const makeService = (over: Partial<EnvConfig> = {}) => {
  const store = new FakeStore();
  const svc = new LlmModelSettingsService(store as unknown as AppSettingsStore, env(over));
  return { store, svc };
};

describe("LlmModelSettingsService (JAK-143)", () => {
  describe("getEffectiveSelection", () => {
    it("an UNSET surface falls back to the exact global Doppler default", async () => {
      const { svc } = makeService({ llmProvider: "openai", openAiModel: "gpt-4o" });
      await expect(svc.getEffectiveSelection("comps")).resolves.toEqual({
        provider: "openai",
        model: "gpt-4o",
      });
    });

    it("an unset surface follows the global provider when it's Anthropic", async () => {
      const { svc } = makeService({ llmProvider: "anthropic", anthropicModel: "claude-opus-4-8" });
      await expect(svc.getEffectiveSelection("orchestrator")).resolves.toEqual({
        provider: "anthropic",
        model: "claude-opus-4-8",
      });
    });

    it("a stored provider+model override resolves to exactly that pair", async () => {
      const { store, svc } = makeService();
      store.seed(KEY.skiptrace, JSON.stringify({ provider: "anthropic", model: "claude-sonnet-4-6" }));
      await expect(svc.getEffectiveSelection("skiptrace")).resolves.toEqual({
        provider: "anthropic",
        model: "claude-sonnet-4-6",
      });
    });

    it("a provider-only override uses THAT provider's default model", async () => {
      const { store, svc } = makeService({ anthropicModel: "claude-opus-4-8" });
      store.seed(KEY.comps, JSON.stringify({ provider: "anthropic", model: null }));
      await expect(svc.getEffectiveSelection("comps")).resolves.toEqual({
        provider: "anthropic",
        model: "claude-opus-4-8",
      });
    });

    it("a corrupt/garbage row degrades to the global default (no throw on the hot path)", async () => {
      const { store, svc } = makeService({ llmProvider: "openai", openAiModel: "gpt-4o" });
      store.seed(KEY.property_report, "not json {");
      await expect(svc.getEffectiveSelection("property_report")).resolves.toEqual({
        provider: "openai",
        model: "gpt-4o",
      });
    });

    it("surfaces are independent — one surface's override never leaks to another", async () => {
      const { store, svc } = makeService();
      store.seed(KEY.comps, JSON.stringify({ provider: "anthropic", model: "claude-sonnet-4-6" }));
      await expect(svc.getEffectiveSelection("comps")).resolves.toEqual({
        provider: "anthropic",
        model: "claude-sonnet-4-6",
      });
      // skiptrace has no row → still the global default.
      await expect(svc.getEffectiveSelection("skiptrace")).resolves.toEqual({
        provider: "openai",
        model: "gpt-4o",
      });
    });
  });

  describe("getView", () => {
    it("an unset surface is default, with the effective + global default surfaced and NO key", async () => {
      const { svc } = makeService({ llmProvider: "openai", openAiModel: "gpt-4o", anthropicApiKey: "" });
      const view = await svc.getView("orchestrator");
      expect(view.isDefault).toBe(true);
      expect(view.provider).toBeNull();
      expect(view.model).toBeNull();
      expect(view.effectiveProvider).toBe("openai");
      expect(view.effectiveModel).toBe("gpt-4o");
      expect(view.defaultProvider).toBe("openai");
      expect(view.defaultModel).toBe("gpt-4o");
      // Key-configured is booleans only — never a key.
      expect(view.providerKeyConfigured).toEqual({ openai: true, anthropic: false });
      expect(JSON.stringify(view)).not.toMatch(/openai-key|sk-/);
    });

    it("a customized surface reports the stored override + edit metadata", async () => {
      const { store, svc } = makeService();
      store.seed(KEY.comps, JSON.stringify({ provider: "anthropic", model: "claude-sonnet-4-6" }));
      const view = await svc.getView("comps");
      expect(view.isDefault).toBe(false);
      expect(view.provider).toBe("anthropic");
      expect(view.model).toBe("claude-sonnet-4-6");
      expect(view.updatedBy).toBe("admin-1");
      expect(view.updatedAt).toEqual(new Date("2026-07-03T00:00:00Z"));
    });
  });

  describe("setSelection + reset", () => {
    it("setSelection persists a provider+model and the next read reflects it immediately", async () => {
      const { store, svc } = makeService();
      const view = await svc.setSelection("comps", "anthropic", "claude-sonnet-4-6", "admin-9");
      expect(view.isDefault).toBe(false);
      expect(view.effectiveModel).toBe("claude-sonnet-4-6");
      // Persisted as JSON under the surface's key.
      expect(JSON.parse((await store.get(KEY.comps))!.value)).toEqual({
        provider: "anthropic",
        model: "claude-sonnet-4-6",
      });
      // Cache-busted: the effective selection reflects the edit at once.
      await expect(svc.getEffectiveSelection("comps")).resolves.toEqual({
        provider: "anthropic",
        model: "claude-sonnet-4-6",
      });
    });

    it("setSelection with a blank model stores null (inherit the provider default)", async () => {
      const { store, svc } = makeService({ anthropicModel: "claude-opus-4-8" });
      await svc.setSelection("skiptrace", "anthropic", "   ", "admin-9");
      expect(JSON.parse((await store.get(KEY.skiptrace))!.value)).toEqual({
        provider: "anthropic",
        model: null,
      });
      await expect(svc.getEffectiveSelection("skiptrace")).resolves.toEqual({
        provider: "anthropic",
        model: "claude-opus-4-8",
      });
    });

    it("reset clears the override and the next read is the global default again", async () => {
      const { store, svc } = makeService({ llmProvider: "openai", openAiModel: "gpt-4o" });
      await svc.setSelection("comps", "anthropic", "claude-sonnet-4-6", "admin-9");
      const view = await svc.reset("comps");
      expect(view.isDefault).toBe(true);
      expect(await store.get(KEY.comps)).toBeNull();
      await expect(svc.getEffectiveSelection("comps")).resolves.toEqual({
        provider: "openai",
        model: "gpt-4o",
      });
    });
  });
});
