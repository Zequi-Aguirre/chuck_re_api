import { normalizeInboundAddress, parseCommandAddress } from "../address";

/**
 * util/address parsing. normalizeInboundAddress is the bare-address gate the report
 * path has always used; parseCommandAddress (JAK-156) adds command-prefix handling so
 * an address typed INSIDE a command ("skip 123 Main St, Tampa FL") is captured rather
 * than discarded. Fixtures use fictional addresses only.
 */
describe("normalizeInboundAddress", () => {
  it("accepts a house-number address with a comma", () => {
    expect(normalizeInboundAddress("123 Main St, Tampa FL")).toBe("123 Main St, Tampa FL");
  });

  it("accepts a house-number address with a ZIP", () => {
    expect(normalizeInboundAddress("123 Main St Tampa FL 33601")).toBe("123 Main St Tampa FL 33601");
  });

  it("collapses whitespace", () => {
    expect(normalizeInboundAddress("  123   Main St,   Tampa FL ")).toBe("123 Main St, Tampa FL");
  });

  it("rejects a non-address", () => {
    expect(normalizeInboundAddress("hi there")).toBeNull();
    expect(normalizeInboundAddress("what's up")).toBeNull();
  });

  it("rejects a house number with no comma and no ZIP", () => {
    expect(normalizeInboundAddress("742 Evergreen Terrace")).toBeNull();
  });

  it("rejects null / empty", () => {
    expect(normalizeInboundAddress(null)).toBeNull();
    expect(normalizeInboundAddress(undefined)).toBeNull();
    expect(normalizeInboundAddress("   ")).toBeNull();
  });
});

describe("parseCommandAddress (JAK-156)", () => {
  it("parses a bare address exactly as normalizeInboundAddress (report path unchanged)", () => {
    expect(parseCommandAddress("123 Main St, Tampa FL")).toBe("123 Main St, Tampa FL");
    expect(parseCommandAddress("123 Main St Tampa FL 33601")).toBe("123 Main St Tampa FL 33601");
  });

  it("strips a leading 'skip' and parses the typed address", () => {
    expect(parseCommandAddress("skip 123 Main St, Tampa FL")).toBe("123 Main St, Tampa FL");
  });

  it("strips 'skiptrace' and 'skip trace' variants", () => {
    expect(parseCommandAddress("skiptrace 123 Main St, Tampa FL")).toBe("123 Main St, Tampa FL");
    expect(parseCommandAddress("skip trace 123 Main St, Tampa FL")).toBe("123 Main St, Tampa FL");
  });

  it("strips 'comp' / 'comps' / 'cma'", () => {
    expect(parseCommandAddress("comps 123 Main St, Tampa FL")).toBe("123 Main St, Tampa FL");
    expect(parseCommandAddress("comp 123 Main St, Tampa FL")).toBe("123 Main St, Tampa FL");
    expect(parseCommandAddress("cma 123 Main St, Tampa FL")).toBe("123 Main St, Tampa FL");
  });

  it("strips 'run' / 'pull'", () => {
    expect(parseCommandAddress("run 123 Main St, Tampa FL")).toBe("123 Main St, Tampa FL");
    expect(parseCommandAddress("pull 123 Main St, Tampa FL")).toBe("123 Main St, Tampa FL");
  });

  it("is case-insensitive and tolerates a separator after the command", () => {
    expect(parseCommandAddress("SKIP 123 Main St, Tampa FL")).toBe("123 Main St, Tampa FL");
    expect(parseCommandAddress("Skip: 123 Main St, Tampa FL")).toBe("123 Main St, Tampa FL");
    expect(parseCommandAddress("comps - 123 Main St, Tampa FL")).toBe("123 Main St, Tampa FL");
  });

  it("returns null for a bare command with no address", () => {
    expect(parseCommandAddress("skip")).toBeNull();
    expect(parseCommandAddress("skip trace")).toBeNull();
    expect(parseCommandAddress("pull comps")).toBeNull();
    expect(parseCommandAddress("run comps")).toBeNull();
  });

  it("returns null when the remainder isn't an address (person / pronoun refs)", () => {
    expect(parseCommandAddress("skip trace the owner")).toBeNull();
    expect(parseCommandAddress("skip trace Jane Doe")).toBeNull();
    expect(parseCommandAddress("skip trace it")).toBeNull();
    expect(parseCommandAddress("comps for the 2nd one")).toBeNull();
  });

  it("does not treat a command word buried mid-message as an address prefix", () => {
    // No leading command, and "the report..." doesn't start with a house number.
    expect(parseCommandAddress("please skip 123 Main St, Tampa FL")).toBeNull();
  });

  it("returns null for null / empty", () => {
    expect(parseCommandAddress(null)).toBeNull();
    expect(parseCommandAddress(undefined)).toBeNull();
    expect(parseCommandAddress("   ")).toBeNull();
  });
});
