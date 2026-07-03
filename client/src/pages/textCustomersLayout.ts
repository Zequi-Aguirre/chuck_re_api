/**
 * Shared layout helpers for the mobile-first text-customers page (JAK-146).
 *
 * Zequi runs the admin dashboard on his phone, so the customer list MUST fit a
 * phone screen with no horizontal scroll. Mirroring the Automator LeadsTable
 * pattern, the page renders CARDS at/below the mobile breakpoint and a TABLE
 * above it. The breakpoint + decision live here (pure, no JSX/MUI) so the
 * branch is unit-testable without a DOM.
 */

/** Viewport width (px) at/below which the list renders as cards, not a table. */
export const TEXT_CUSTOMERS_MOBILE_MAX_WIDTH = 900;

/** MUI media query string the page passes to `useMediaQuery`. */
export const TEXT_CUSTOMERS_MOBILE_QUERY = `(max-width:${TEXT_CUSTOMERS_MOBILE_MAX_WIDTH}px)`;

/** True when the viewport is at/below the mobile breakpoint (→ render cards). */
export function isMobileWidth(width: number): boolean {
  return width <= TEXT_CUSTOMERS_MOBILE_MAX_WIDTH;
}

/** Which layout the list should use for a given `isMobile` flag. */
export function customerListLayout(isMobile: boolean): "cards" | "table" {
  return isMobile ? "cards" : "table";
}

/** Full display name from first/last, or "" when the customer is unnamed. */
export function customerDisplayName(customer: {
  firstName: string | null;
  lastName: string | null;
}): string {
  return [customer.firstName, customer.lastName]
    .map((part) => (part ?? "").trim())
    .filter(Boolean)
    .join(" ");
}
