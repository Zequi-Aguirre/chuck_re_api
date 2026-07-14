import { normalizePhone } from "../phoneNormalization";

/**
 * JAK-dedup-customers — the canonical phone normalizer. Proves every shape the two
 * customer-create paths used to persist (GHL E.164 vs admin-typed formatted) folds
 * to the SAME +1XXXXXXXXXX key, so a number can never split into two customer rows.
 */
describe("normalizePhone (JAK-dedup-customers)", () => {
  const CANONICAL = "+14845076216";

  it("canonicalizes every accepted format of the same number to one E.164 key", () => {
    // The exact shapes from the ticket + the common variants in between.
    expect(normalizePhone("+14845076216")).toBe(CANONICAL); // GHL E.164
    expect(normalizePhone("(484)507-6216")).toBe(CANONICAL); // admin-typed formatted
    expect(normalizePhone("(484) 507-6216")).toBe(CANONICAL);
    expect(normalizePhone("484-507-6216")).toBe(CANONICAL); // bare 10-digit
    expect(normalizePhone("484.507.6216")).toBe(CANONICAL);
    expect(normalizePhone("4845076216")).toBe(CANONICAL);
    expect(normalizePhone("14845076216")).toBe(CANONICAL); // 11-digit, leading 1
    expect(normalizePhone("1 (484) 507-6216")).toBe(CANONICAL);
    expect(normalizePhone("  +1 484 507 6216  ")).toBe(CANONICAL);
  });

  it("collapses the second ticket example the same way", () => {
    expect(normalizePhone("+17865274077")).toBe("+17865274077");
    expect(normalizePhone("(786)527-4077")).toBe("+17865274077");
  });

  it("is idempotent — normalizing an already-canonical value is a no-op", () => {
    expect(normalizePhone(CANONICAL)).toBe(CANONICAL);
    expect(normalizePhone(normalizePhone("(484) 507-6216"))).toBe(CANONICAL);
  });

  it("keeps a non-US E.164 number as one stable key without guessing +1", () => {
    // 12 digits -> not the 10/11 US shape, so preserved behind a single '+'.
    expect(normalizePhone("+44 20 7946 0958")).toBe("+442079460958");
    expect(normalizePhone("+442079460958")).toBe("+442079460958");
  });

  it("does not merge two genuinely different numbers", () => {
    expect(normalizePhone("+14845076216")).not.toBe(normalizePhone("+17865274077"));
  });
});
