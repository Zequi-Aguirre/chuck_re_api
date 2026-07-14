import { ExternalActionGuard } from "../ExternalActionGuard";
import { EnvConfig } from "../../config/envConfig";

/** A minimal EnvConfig stand-in exposing just the stage flags the guard reads. */
const envWith = (flags: { isProduction: boolean; isStaging: boolean }): EnvConfig =>
  flags as unknown as EnvConfig;

describe("ExternalActionGuard", () => {
  describe("liveActionsAllowed (the single env gate)", () => {
    it("allows real actions in production", () => {
      const guard = new ExternalActionGuard(envWith({ isProduction: true, isStaging: false }));
      expect(guard.liveActionsAllowed).toBe(true);
    });

    it("allows real actions in staging (dedicated test sub-account)", () => {
      const guard = new ExternalActionGuard(envWith({ isProduction: false, isStaging: true }));
      expect(guard.liveActionsAllowed).toBe(true);
    });

    it("NEVER allows real actions in dev", () => {
      const guard = new ExternalActionGuard(envWith({ isProduction: false, isStaging: false }));
      expect(guard.liveActionsAllowed).toBe(false);
    });
  });

  it("echoSkipped writes a single secret-free line to the sink", () => {
    const guard = new ExternalActionGuard(envWith({ isProduction: false, isStaging: false }));
    const spy = jest.spyOn(console, "log").mockImplementation(() => {});

    guard.echoSkipped("GHL write", "PUT /contacts/ct_1 (location loc_1)");

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toContain("[dev safety] skipped GHL write");
    spy.mockRestore();
  });
});
