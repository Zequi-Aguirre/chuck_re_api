import { parseOrdinalSelection, parsePersonReference } from "../references";

/**
 * JAK-138 — the pure follow-up parsers. Reference resolution stays deterministic
 * and testable in code (the JAK-135 principle): a bare number/ordinal picks an
 * address from a list Jake showed; a person reference points into a prior trace.
 */
describe("parseOrdinalSelection (JAK-138 numbered selection)", () => {
  it("reads plain digits, hashes, and ordinal suffixes", () => {
    expect(parseOrdinalSelection("2")).toBe(2);
    expect(parseOrdinalSelection("#2")).toBe(2);
    expect(parseOrdinalSelection("2nd")).toBe(2);
    expect(parseOrdinalSelection("the 3rd")).toBe(3);
  });

  it("reads ordinal words and 'last'", () => {
    expect(parseOrdinalSelection("second")).toBe(2);
    expect(parseOrdinalSelection("the second one")).toBe(2);
    expect(parseOrdinalSelection("last")).toBe("last");
    expect(parseOrdinalSelection("the last one")).toBe("last");
  });

  it("is case-insensitive and tolerates trailing punctuation", () => {
    expect(parseOrdinalSelection("First.")).toBe(1);
    expect(parseOrdinalSelection("  2 ")).toBe(2);
  });

  it("returns null for anything that isn't a bare selection", () => {
    expect(parseOrdinalSelection("ok")).toBeNull();
    expect(parseOrdinalSelection("yes")).toBeNull();
    expect(parseOrdinalSelection("skip trace 2 Main St")).toBeNull();
    expect(parseOrdinalSelection("comps for the 2nd house please tomorrow")).toBeNull();
    expect(parseOrdinalSelection("")).toBeNull();
  });

  it("rejects a zero pick (ordinals are 1-based)", () => {
    expect(parseOrdinalSelection("0")).toBeNull();
  });
});

describe("parsePersonReference (JAK-138 person reference)", () => {
  it("matches an ordinal + person noun", () => {
    expect(parsePersonReference("skip trace the 3rd person")).toEqual({ matched: true, ordinal: 3 });
    expect(parsePersonReference("the 2nd owner")).toEqual({ matched: true, ordinal: 2 });
    expect(parsePersonReference("third owner")).toEqual({ matched: true, ordinal: 3 });
  });

  it("matches a demonstrative + person noun without an ordinal", () => {
    expect(parsePersonReference("that owner")).toEqual({ matched: true, ordinal: null });
    expect(parsePersonReference("skip trace this person")).toEqual({ matched: true, ordinal: null });
  });

  it("does NOT match a plain first-time skip-trace request", () => {
    expect(parsePersonReference("find the owner").matched).toBe(false);
    expect(parsePersonReference("who owns 123 Main St").matched).toBe(false);
    expect(parsePersonReference("skip trace it").matched).toBe(false);
  });
});
