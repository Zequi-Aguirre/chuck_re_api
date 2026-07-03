import {
  TEXT_CUSTOMERS_MOBILE_MAX_WIDTH,
  TEXT_CUSTOMERS_MOBILE_QUERY,
  isMobileWidth,
  customerListLayout,
  customerDisplayName,
  customerStatusLabel,
  customerStatusColor,
} from "../textCustomersLayout";

/**
 * The text-customers page is mobile-first (JAK-146): at/below the breakpoint it
 * must render the list as CARDS, not the wide table (which would force the phone
 * to scroll horizontally). These pin the branch decision + the breakpoint so a
 * regression that flips the mobile view back to a table fails here.
 */
describe("textCustomersLayout (JAK-146 mobile-first)", () => {
  it("uses a 900px breakpoint media query", () => {
    expect(TEXT_CUSTOMERS_MOBILE_MAX_WIDTH).toBe(900);
    expect(TEXT_CUSTOMERS_MOBILE_QUERY).toBe("(max-width:900px)");
  });

  it("treats phone-sized viewports as mobile (→ cards)", () => {
    for (const width of [320, 375, 414, 768, 900]) {
      expect(isMobileWidth(width)).toBe(true);
      expect(customerListLayout(isMobileWidth(width))).toBe("cards");
    }
  });

  it("treats desktop viewports as non-mobile (→ table)", () => {
    for (const width of [901, 1024, 1440]) {
      expect(isMobileWidth(width)).toBe(false);
      expect(customerListLayout(isMobileWidth(width))).toBe("table");
    }
  });

  it("builds a display name from first/last, falling back to empty when unnamed", () => {
    expect(customerDisplayName({ firstName: "Ada", lastName: "Lovelace" })).toBe("Ada Lovelace");
    expect(customerDisplayName({ firstName: "Ada", lastName: null })).toBe("Ada");
    expect(customerDisplayName({ firstName: null, lastName: null })).toBe("");
  });

  it("maps hold status to a friendly label + chip color (JAK-148)", () => {
    expect(customerStatusLabel("active")).toBe("Active");
    expect(customerStatusLabel("on_hold")).toBe("On hold");
    expect(customerStatusLabel("deactivated")).toBe("Deactivated");
    expect(customerStatusColor("active")).toBe("success");
    expect(customerStatusColor("on_hold")).toBe("warning");
    expect(customerStatusColor("deactivated")).toBe("error");
  });
});
