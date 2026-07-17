/**
 * JAK-193 — structured address assembly for the auto-enrichment REAPI lookup.
 *
 * Covers the two live production failures + the normal case:
 *   - a 'z:' (and other label) prefix on the zip is ALWAYS stripped to bare digits;
 *   - a missing state is derived from the zip;
 *   - a clean payload is unchanged.
 */
import {
  buildAddressParts,
  displayAddress,
  normalizeStateCode,
  parseAddressLine,
  parseLocalityTail,
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

describe("buildAddressParts — structured fields, or full-address-in-line1 (JAK-195)", () => {
  it("Eric's case: full address in line1, city/state/zip empty → parsed", () => {
    expect(
      buildAddressParts({ line1: "14001 N 127th Ln, El Mirage, AZ 85335" })
    ).toEqual({ house: "14001", street: "N 127th Ln", city: "El Mirage", state: "AZ", zip: "85335" });
  });

  it("full address in line1 with the state omitted → state derived from zip", () => {
    expect(
      buildAddressParts({ line1: "3165 Tracy Rd, atoka, 38004" })
    ).toEqual({ house: "3165", street: "Tracy Rd", city: "atoka", state: "TN", zip: "38004" });
  });

  it("STRUCTURED fields still win — a normal payload is unchanged (no regression)", () => {
    expect(
      buildAddressParts({ line1: "742 Evergreen Terrace", city: "Springfield", state: "IL", postal: "62704" })
    ).toEqual({ house: "742", street: "Evergreen Terrace", city: "Springfield", state: "IL", zip: "62704" });
  });

  it("does NOT mistake a comma-laden line1 for the street when the zip IS a field", () => {
    // postal present → structured path wins; line1 is treated as-is (pre-existing).
    const parts = buildAddressParts({ line1: "742 Evergreen Terrace", city: "Springfield", state: "IL", postal: "62704" });
    expect(parts?.street).toBe("Evergreen Terrace");
  });

  it.each([
    ["bare street, no zip anywhere", { line1: "742 Evergreen Terrace" }],
    ["street + city only, no zip", { line1: "742 Evergreen Terrace, Springfield" }],
    ["empty", {}],
  ])("returns null when there's no zip to key on (%s)", (_label, fields) => {
    expect(buildAddressParts(fields)).toBeNull();
  });
});

// JAK-196 — a dirty line1 carrying the WHOLE address must yield a CLEAN street,
// whether or not the structured city/state/zip are also present.
describe("buildAddressParts — dirty full-address-in-line1 (JAK-196)", () => {
  const CLEAN = { house: "828", street: "Pearson Oaks Dr", city: "collierville", state: "TN", zip: "38017" };

  it("CASE 1: comma line1 + structured city/state/zip ALSO filled → clean street (was polluted)", () => {
    expect(
      buildAddressParts({
        line1: "828 Pearson Oaks Dr, collierville, TN, 38017",
        city: "collierville",
        state: "TN",
        postal: "38017",
      })
    ).toEqual(CLEAN);
  });

  it("comma line1, structured EMPTY → still clean (JAK-195 shape, state as its own comma part)", () => {
    expect(buildAddressParts({ line1: "828 Pearson Oaks Dr, collierville, TN, 38017" })).toEqual(CLEAN);
  });

  it("no-comma blob + structured city/state/zip → trailing locality stripped off the street", () => {
    expect(
      buildAddressParts({
        line1: "828 Pearson Oaks Dr collierville TN 38017",
        city: "collierville",
        state: "TN",
        postal: "38017",
      })
    ).toEqual(CLEAN);
  });

  it("no-comma blob with structured EMPTY → null (nothing to anchor on; worker's LLM handles it)", () => {
    expect(buildAddressParts({ line1: "828 Pearson Oaks Dr collierville TN 38017" })).toBeNull();
  });

  it("strips a trailing full state NAME using the structured code as the anchor", () => {
    expect(
      buildAddressParts({
        line1: "742 Evergreen Terrace Springfield IL 62704",
        city: "Springfield",
        state: "IL",
        postal: "62704",
      })
    ).toEqual({ house: "742", street: "Evergreen Terrace", city: "Springfield", state: "IL", zip: "62704" });
  });

  it("NO REGRESSION: a plain street + structured fields is untouched (no over-strip)", () => {
    expect(
      buildAddressParts({ line1: "500 Main St", city: "Dallas", state: "TX", postal: "75001" })
    ).toEqual({ house: "500", street: "Main St", city: "Dallas", state: "TX", zip: "75001" });
  });
});

describe("parseLocalityTail (JAK-196)", () => {
  it("parses 'city, ST, zip' with the zip as its own comma segment", () => {
    expect(parseLocalityTail("collierville, TN, 38017")).toEqual({
      city: "collierville",
      state: "TN",
      zip: "38017",
    });
  });

  it("parses a space-delimited tail and strips a z: label off the zip", () => {
    expect(parseLocalityTail("El Mirage AZ z:85335")).toEqual({
      city: "El Mirage",
      state: "AZ",
      zip: "85335",
    });
  });

  it("leaves state undefined when the last token isn't a state", () => {
    expect(parseLocalityTail("atoka 38004")).toEqual({ city: "atoka", state: undefined, zip: "38004" });
  });

  it("returns an empty object for a blank tail", () => {
    expect(parseLocalityTail("")).toEqual({});
    expect(parseLocalityTail(undefined)).toEqual({});
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
