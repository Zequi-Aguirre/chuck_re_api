import {
  CREDIT_TYPES,
  creditTypeLabel,
  creditTypeShort,
  defaultGrantKey,
  outOfCreditsMessageKey,
  balanceOf,
} from "../creditsLayout";

/**
 * The per-feature credit UI (JAK-161/JAK-162) shows THREE independent buckets in
 * three places (customer card/table, grant dialog, credit settings). These pin
 * the shared bucket order, labels, and the app_settings key mapping so the SPA
 * and the server never drift — and so a missing bucket renders 0, not a crash.
 */
describe("creditsLayout (JAK-162 per-feature credits)", () => {
  it("orders the three buckets report → skiptrace → comps", () => {
    expect(CREDIT_TYPES).toEqual(["report", "skiptrace", "comps"]);
  });

  it("maps each bucket to a full + short label", () => {
    expect(creditTypeLabel("report")).toBe("Report");
    expect(creditTypeLabel("skiptrace")).toBe("Skip-trace");
    expect(creditTypeLabel("comps")).toBe("Comps");
    expect(creditTypeShort("report")).toBe("Report");
    expect(creditTypeShort("skiptrace")).toBe("Skip");
    expect(creditTypeShort("comps")).toBe("Comps");
  });

  it("builds the app_settings keys the server owns (JAK-161)", () => {
    expect(defaultGrantKey("report")).toBe("default_report_credits");
    expect(defaultGrantKey("skiptrace")).toBe("default_skiptrace_credits");
    expect(defaultGrantKey("comps")).toBe("default_comps_credits");
    expect(outOfCreditsMessageKey("report")).toBe("out_of_credits_message_report");
    expect(outOfCreditsMessageKey("comps")).toBe("out_of_credits_message_comps");
  });

  it("reads a bucket's balance, defaulting a missing bucket to 0", () => {
    const credits = { report: 100, skiptrace: 10, comps: 3 };
    expect(balanceOf(credits, "report")).toBe(100);
    expect(balanceOf(credits, "skiptrace")).toBe(10);
    expect(balanceOf(credits, "comps")).toBe(3);
    // A pre-split / undefined balance set reads every bucket as 0, never undefined.
    expect(balanceOf(undefined, "comps")).toBe(0);
  });
});
