/**
 * Shared mobile-first layout helpers for the admin dashboard (JAK-149).
 *
 * Zequi runs the admin dashboard on his phone, and a real incident happened: an
 * admin couldn't find the "Add" button because a wide table pushed it off-screen
 * to the right (horizontal scroll). To prevent that everywhere, admin pages that
 * show a data table render CARDS at/below the mobile breakpoint and a TABLE above
 * it — the same rule the text-customers page (JAK-146) already follows, and the
 * same pattern as the Automator LeadsTable.
 *
 * The breakpoint + the card-vs-table decision live here (pure, no JSX/MUI) so the
 * branch is unit-testable without a DOM and every page shares ONE breakpoint. The
 * text-customers page keeps its own identical 900px constant (JAK-146) so it stays
 * self-contained; both agree on 900.
 */

/** Viewport width (px) at/below which admin lists render as cards, not a table. */
export const ADMIN_MOBILE_MAX_WIDTH = 900;

/** MUI media query string admin pages pass to `useMediaQuery`. */
export const ADMIN_MOBILE_QUERY = `(max-width:${ADMIN_MOBILE_MAX_WIDTH}px)`;

/** True when the viewport is at/below the mobile breakpoint (→ render cards). */
export function isMobileWidth(width: number): boolean {
  return width <= ADMIN_MOBILE_MAX_WIDTH;
}

/** Which layout a data list should use for a given `isMobile` flag. */
export function adminListLayout(isMobile: boolean): "cards" | "table" {
  return isMobile ? "cards" : "table";
}
