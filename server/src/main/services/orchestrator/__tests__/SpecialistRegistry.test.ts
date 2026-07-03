import { SpecialistRegistry } from "../SpecialistRegistry";

/**
 * The specialist registry (JAK-135) is the registration seam for JAK-136/137.
 * These tests pin the seeded descriptors and that a later ticket can flip a
 * capability to "available" (or override its cost) WITHOUT the router changing.
 */
describe("SpecialistRegistry (JAK-135)", () => {
  it("seeds report, skip_trace, and comps as BUILT", () => {
    const registry = new SpecialistRegistry();

    expect(registry.get(SpecialistRegistry.REPORT)).toEqual({
      name: "report",
      needsConfirmation: false,
      estimatedCredits: 1,
      available: true,
    });
    expect(registry.isAvailable(SpecialistRegistry.REPORT)).toBe(true);

    // JAK-136: skip trace is now BUILT + confirm-before-spend (costs more than a report).
    expect(registry.get(SpecialistRegistry.SKIP_TRACE)).toEqual({
      name: "skip_trace",
      needsConfirmation: true,
      estimatedCredits: 3,
      available: true,
    });
    expect(registry.isAvailable(SpecialistRegistry.SKIP_TRACE)).toBe(true);

    // JAK-137: comps is now BUILT + confirm-before-spend (costs more than a report).
    expect(registry.get(SpecialistRegistry.COMPS)).toEqual({
      name: "comps",
      needsConfirmation: true,
      estimatedCredits: 3,
      available: true,
    });
    expect(registry.isAvailable(SpecialistRegistry.COMPS)).toBe(true);
  });

  it("returns null for an unknown specialist name", () => {
    expect(new SpecialistRegistry().get("nope")).toBeNull();
    expect(new SpecialistRegistry().isAvailable("nope")).toBe(false);
  });

  it("lets a later ticket register/override a specialist (JAK-136 flipping skip_trace live)", () => {
    const registry = new SpecialistRegistry();

    // Simulate JAK-136 plugging in: mark skip_trace built with a firm cost.
    registry.register({ name: SpecialistRegistry.SKIP_TRACE, needsConfirmation: true, estimatedCredits: 3, available: true });

    expect(registry.isAvailable(SpecialistRegistry.SKIP_TRACE)).toBe(true);
    expect(registry.get(SpecialistRegistry.SKIP_TRACE)).toEqual({
      name: "skip_trace",
      needsConfirmation: true,
      estimatedCredits: 3,
      available: true,
    });
  });
});
