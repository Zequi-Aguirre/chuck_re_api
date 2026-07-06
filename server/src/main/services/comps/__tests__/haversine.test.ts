import { haversineMiles } from "../haversine";

/**
 * JAK-160 — the great-circle (haversine) distance util. The comps endpoint ships
 * lat/long on the subject and every comp but NO distance field, so we compute the
 * honest miles ourselves. These pin correctness against known coordinate pairs and
 * the null-safety the assembler relies on (a comp missing coords carries no
 * distance rather than a bogus 0/NaN).
 */
describe("haversineMiles (JAK-160)", () => {
  it("is zero for identical points", () => {
    expect(haversineMiles(40.7128, -74.006, 40.7128, -74.006)).toBeCloseTo(0, 6);
  });

  it("one degree of longitude at the equator is ~69 miles", () => {
    const miles = haversineMiles(0, 0, 0, 1)!;
    expect(miles).toBeGreaterThan(68);
    expect(miles).toBeLessThan(70);
  });

  it("one degree of latitude is ~69 miles anywhere", () => {
    const miles = haversineMiles(38, -77, 39, -77)!;
    expect(miles).toBeGreaterThan(68);
    expect(miles).toBeLessThan(70);
  });

  it("matches the known NYC -> LA great-circle distance (~2445 mi)", () => {
    // New York City (40.7128, -74.0060) to Los Angeles (34.0522, -118.2437).
    const miles = haversineMiles(40.7128, -74.006, 34.0522, -118.2437)!;
    expect(miles).toBeGreaterThan(2420);
    expect(miles).toBeLessThan(2470);
  });

  it("computes a small sub-mile neighbor distance", () => {
    // ~0.6 mi apart in Washington, DC.
    const miles = haversineMiles(38.898, -77.037, 38.897, -77.048)!;
    expect(miles).toBeGreaterThan(0.5);
    expect(miles).toBeLessThan(0.7);
  });

  it("returns null when any coordinate is missing or non-finite", () => {
    expect(haversineMiles(null, -77, 39, -77)).toBeNull();
    expect(haversineMiles(38, undefined, 39, -77)).toBeNull();
    expect(haversineMiles(38, -77, 39, NaN)).toBeNull();
    expect(haversineMiles(undefined, undefined, undefined, undefined)).toBeNull();
  });
});
