import { buildCreditBalanceMessage, formatResetDate } from "../creditStatusMessage";

/**
 * Pure-text tests for the READ-ONLY credit-status reply (JAK-credit-keyword):
 * per-bucket balances + a human-friendly reset date, emoji-free and TTS-friendly,
 * with the reset sentence dropped gracefully when the date is unknown.
 */
describe("creditStatusMessage (JAK-credit-keyword)", () => {
  // Same emoji guard the welcome/onboarding copy is held to.
  const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}️]/u;

  it("reports all three balances and the reset date, matching the ticket wording", () => {
    const msg = buildCreditBalanceMessage({
      report: 50,
      skiptrace: 10,
      comps: 10,
      nextResetAt: new Date("2026-08-07T00:00:00Z"),
    });
    expect(msg).toBe(
      "You have 50 report credits, 10 skip trace credits, and 10 comps credits. They reset on August 7."
    );
    expect(EMOJI_RE.test(msg)).toBe(false);
  });

  it("pluralizes each bucket independently (1 credit vs 0/N credits)", () => {
    const msg = buildCreditBalanceMessage({
      report: 1,
      skiptrace: 0,
      comps: 2,
      nextResetAt: new Date("2026-12-01T12:00:00Z"),
    });
    expect(msg).toBe(
      "You have 1 report credit, 0 skip trace credits, and 2 comps credits. They reset on December 1."
    );
  });

  it("omits the reset sentence when the reset date is unknown (null)", () => {
    const msg = buildCreditBalanceMessage({ report: 5, skiptrace: 3, comps: 4, nextResetAt: null });
    expect(msg).toBe("You have 5 report credits, 3 skip trace credits, and 4 comps credits.");
    expect(msg).not.toContain("reset");
  });

  it("formats the reset date as month name + day (UTC, no year)", () => {
    expect(formatResetDate(new Date("2026-08-07T23:30:00Z"))).toBe("August 7");
    expect(formatResetDate(new Date("2027-01-31T00:00:00Z"))).toBe("January 31");
  });
});
