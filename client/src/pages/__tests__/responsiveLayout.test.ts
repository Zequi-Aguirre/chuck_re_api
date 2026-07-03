import {
  ADMIN_MOBILE_MAX_WIDTH,
  ADMIN_MOBILE_QUERY,
  isMobileWidth,
  adminListLayout,
} from "../responsiveLayout";

/**
 * The admin dashboard is mobile-first (JAK-149): at/below the breakpoint every
 * data-table page (sub-accounts, admins, connection detail) must render CARDS,
 * not a wide table that forces the phone to scroll horizontally and hides the
 * primary action off-screen. These pin the shared breakpoint + branch decision
 * so a regression that flips a mobile view back to a table fails here.
 */
describe("responsiveLayout (JAK-149 mobile-first admin)", () => {
  it("uses a 900px breakpoint media query, matching text-customers (JAK-146)", () => {
    expect(ADMIN_MOBILE_MAX_WIDTH).toBe(900);
    expect(ADMIN_MOBILE_QUERY).toBe("(max-width:900px)");
  });

  it("treats phone-sized viewports as mobile (→ cards)", () => {
    for (const width of [320, 375, 414, 768, 900]) {
      expect(isMobileWidth(width)).toBe(true);
      expect(adminListLayout(isMobileWidth(width))).toBe("cards");
    }
  });

  it("treats desktop viewports as non-mobile (→ table)", () => {
    for (const width of [901, 1024, 1440]) {
      expect(isMobileWidth(width)).toBe(false);
      expect(adminListLayout(isMobileWidth(width))).toBe("table");
    }
  });
});
