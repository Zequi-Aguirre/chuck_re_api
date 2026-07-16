/**
 * JAK-193 — structured address assembly for the auto-enrichment REAPI lookup.
 *
 * Covers the two live production failures + the normal case:
 *   - a 'z:' (and other label) prefix on the zip is ALWAYS stripped to bare digits;
 *   - a missing state is derived from the zip;
 *   - a clean payload is unchanged.
 */
import {
  displayAddress,
  normalizeStateCode,
  parseAddressLine,
  partsFromFields,
  sanitizeZip,
  splitStreet,
  stateFromZip,
} from "../addressParts";

describe("sanitizeZip — bare zip is a HARD requirement (JAK-193)", () => {
  it.each([
    ["z:85335", "85335"], // the live GHL label leak
    ["zip:85335", "85335"],
    ["ZIP: 85335", "85335"],
    [" 85335 ", "85335"],
    ["85335", "85335"],
    ["85335-1234", "85335-1234"], // ZIP+4 preserved
    ["postal 90210 ", "90210"],
  ])("normalizes %p → %p", (input, expected) => {
    expect(sanitizeZip(input)).toBe(expected);
  });

  it.each([undefined, null, "", "abc", "z:1234", "no digits here"])(
    "returns undefined for %p (no 5-digit run)",
    (input) => {
      expect(sanitizeZip(input as string | undefined)).toBeUndefined();
    }
  );
});

describe("normalizeStateCode", () => {
  it.each([
    ["AZ", "AZ"],
    ["az", "AZ"],
    ["Il", "IL"],
    ["Arizona", "AZ"],
    ["arizona", "AZ"],
    ["new york", "NY"],
    ["N.Y", "NY"],
  ])("maps %p → %p", (input, expected) => {
    expect(normalizeStateCode(input)).toBe(expected);
  });

  it.each([undefined, null, "", "ZZ", "z:", "atoka", "Springfield"])(
    "returns undefined for %p",
    (input) => {
      expect(normalizeStateCode(input as string | undefined)).toBeUndefined();
    }
  );
});

describe("stateFromZip — ZIP3 → state fallback", () => {
  it.each([
    ["85335", "AZ"], // live Case 1
    ["38004", "TN"], // live Case 2
    ["62704", "IL"],
    ["90210", "CA"],
    ["10001", "NY"],
    ["75001", "TX"],
    ["33101", "FL"],
    ["99501", "AK"],
    ["z:85335", "AZ"], // sanitizes first
  ])("derives %p → %p", (zip, expected) => {
    expect(stateFromZip(zip)).toBe(expected);
  });

  it.each([undefined, "", "abc", "00000"])("returns undefined for %p", (zip) => {
    expect(stateFromZip(zip as string | undefined)).toBeUndefined();
  });
});

describe("splitStreet", () => {
  it("splits house number from the street name", () => {
    expect(splitStreet("14001 N 127th Ln")).toEqual({ house: "14001", street: "N 127th Ln" });
    expect(splitStreet("  3165 Tracy Rd  ")).toEqual({ house: "3165", street: "Tracy Rd" });
  });

  it.each([undefined, "", "Main St", "PO Box"])("returns undefined without a leading number: %p", (v) => {
    expect(splitStreet(v as string | undefined)).toBeUndefined();
  });
});

describe("partsFromFields — the worker's structured builder", () => {
  it("Case 1: strips the z: label off the zip", () => {
    expect(
      partsFromFields({ line1: "14001 N 127th Ln", city: "El Mirage", state: "AZ", postal: "z:85335" })
    ).toEqual({ house: "14001", street: "N 127th Ln", city: "El Mirage", state: "AZ", zip: "85335" });
  });

  it("Case 2: derives the state from the zip when GHL omits it", () => {
    expect(
      partsFromFields({ line1: "3165 Tracy Rd", city: "atoka", postal: "38004" })
    ).toEqual({ house: "3165", street: "Tracy Rd", city: "atoka", state: "TN", zip: "38004" });
  });

  it("normal clean payload is passed through unchanged", () => {
    expect(
      partsFromFields({ line1: "742 Evergreen Terrace", city: "Springfield", state: "IL", postal: "62704" })
    ).toEqual({ house: "742", street: "Evergreen Terrace", city: "Springfield", state: "IL", zip: "62704" });
  });

  it("leaves state empty when neither the payload nor the zip resolves one", () => {
    // 009xx is a Puerto Rico/APO gap in our table → undefined → "".
    expect(
      partsFromFields({ line1: "1 Test St", city: "Nowhere", postal: "00000" })
    ).toEqual({ house: "1", street: "Test St", city: "Nowhere", state: "", zip: "00000" });
  });

  it.each([
    ["no street number", { line1: "Main St", city: "X", state: "TX", postal: "75001" }],
    ["no zip", { line1: "1 Main St", city: "X", state: "TX", postal: "nope" }],
    ["empty", {}],
  ])("returns null when unusable (%s)", (_label, fields) => {
    expect(partsFromFields(fields)).toBeNull();
  });
});

describe("parseAddressLine — combined rawContact.address string fallback", () => {
  it("parses a full street/city/state/zip line", () => {
    expect(parseAddressLine("14001 N 127th Ln, El Mirage, AZ z:85335")).toEqual({
      house: "14001",
      street: "N 127th Ln",
      city: "El Mirage",
      state: "AZ",
      zip: "85335",
    });
  });

  it("derives the state from the zip when the line omits it", () => {
    expect(parseAddressLine("3165 Tracy Rd, atoka, 38004")).toEqual({
      house: "3165",
      street: "Tracy Rd",
      city: "atoka",
      state: "TN",
      zip: "38004",
    });
  });

  it.each([undefined, "", "just a name", "no, zip, here"])("returns null for %p", (line) => {
    expect(parseAddressLine(line as string | undefined)).toBeNull();
  });
});

describe("displayAddress", () => {
  it("renders a clean one-line string for logs", () => {
    expect(
      displayAddress({ house: "14001", street: "N 127th Ln", city: "El Mirage", state: "AZ", zip: "85335" })
    ).toBe("14001 N 127th Ln, El Mirage, AZ 85335");
  });

  it("omits an empty city/state", () => {
    expect(
      displayAddress({ house: "1", street: "Test St", city: "", state: "", zip: "00000" })
    ).toBe("1 Test St, 00000");
  });
});
