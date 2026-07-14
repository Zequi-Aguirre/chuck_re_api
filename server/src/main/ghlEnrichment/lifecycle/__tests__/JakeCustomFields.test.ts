import { JAKE_CUSTOM_FIELDS, normalizeFieldKey } from "../JakeCustomFields";

describe("JAKE_CUSTOM_FIELDS catalog", () => {
  it("has unique, stable snake_case keys (the idempotency + write-back anchor)", () => {
    const keys = JAKE_CUSTOM_FIELDS.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) {
      expect(key).toMatch(/^jake_[a-z0-9_]+$/);
    }
  });

  it("has a non-empty name and data type for every field", () => {
    for (const f of JAKE_CUSTOM_FIELDS) {
      expect(f.name.length).toBeGreaterThan(0);
      expect(f.dataType.length).toBeGreaterThan(0);
    }
  });
});

describe("normalizeFieldKey", () => {
  it("strips GHL's model prefix so a returned key matches our canonical key", () => {
    expect(normalizeFieldKey("contact.jake_owner_name")).toBe("jake_owner_name");
  });

  it("leaves an already-bare key unchanged", () => {
    expect(normalizeFieldKey("jake_owner_name")).toBe("jake_owner_name");
  });
});
