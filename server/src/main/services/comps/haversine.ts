// JAK-160 — great-circle distance between two lat/long points, in MILES.
//
// The comps endpoint (POST /v2/PropertyDetail comps:true) ships lat/long on the
// subject AND every comp, but NO distance field — the old `comp.distance` mapping
// was always empty. We compute the honest distance ourselves with the haversine
// formula: no maps API, no network, no cost. Pure + null-safe.

/** Mean Earth radius in miles (WGS-84 authalic radius, the standard for haversine). */
const EARTH_RADIUS_MILES = 3958.7613;

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

/**
 * Great-circle distance in miles between two (latitude, longitude) points using the
 * haversine formula. Returns null if any coordinate is missing or non-finite, so a
 * comp with no coordinates simply carries no distance (never a bogus 0 or NaN).
 */
export function haversineMiles(
  lat1: number | null | undefined,
  lon1: number | null | undefined,
  lat2: number | null | undefined,
  lon2: number | null | undefined
): number | null {
  if (
    !Number.isFinite(lat1 as number) ||
    !Number.isFinite(lon1 as number) ||
    !Number.isFinite(lat2 as number) ||
    !Number.isFinite(lon2 as number)
  ) {
    return null;
  }

  const dLat = toRadians((lat2 as number) - (lat1 as number));
  const dLon = toRadians((lon2 as number) - (lon1 as number));
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1 as number)) *
      Math.cos(toRadians(lat2 as number)) *
      Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_MILES * c;
}
