/** Field-force helpers: geo distance, geofencing and route ordering for sales reps. */

export interface GeoPoint {
  lat: number;
  lng: number;
}

/** Great-circle distance in meters (haversine). */
export function distanceMeters(a: GeoPoint, b: GeoPoint): number {
  const R = 6_371_000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}

export interface RouteStop extends GeoPoint {
  id: string;
  priority?: number; // higher = visit earlier (e.g. overdue balance, big account)
}

/**
 * Order stops for a day's route: nearest-neighbour from the start point, then 2-opt improvement.
 * Priority stops (priority > 0) are visited first, in priority order, before the optimized remainder.
 * Good enough for 5–60 daily stops; a VRP solver can replace it later behind the same signature.
 */
export function planRoute(start: GeoPoint, stops: RouteStop[]): { order: RouteStop[]; totalMeters: number } {
  const urgent = stops.filter((s) => (s.priority ?? 0) > 0).sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  const rest = stops.filter((s) => (s.priority ?? 0) <= 0);

  const ordered: RouteStop[] = [...urgent];
  let cur: GeoPoint = urgent.at(-1) ?? start;
  const pool = [...rest];
  while (pool.length) {
    let best = 0;
    for (let i = 1; i < pool.length; i++) {
      if (distanceMeters(cur, pool[i]!) < distanceMeters(cur, pool[best]!)) best = i;
    }
    const next = pool.splice(best, 1)[0]!;
    ordered.push(next);
    cur = next;
  }

  // 2-opt on the non-urgent tail
  const fixed = urgent.length;
  const pathLen = (r: GeoPoint[]) => r.reduce((s, p, i) => (i === 0 ? 0 : s + distanceMeters(r[i - 1]!, p)), 0);
  let improved = true;
  let route: GeoPoint[] = [start, ...ordered];
  while (improved) {
    improved = false;
    for (let i = fixed + 1; i < route.length - 1; i++) {
      for (let k = i + 1; k < route.length; k++) {
        const candidate = [...route.slice(0, i), ...route.slice(i, k + 1).reverse(), ...route.slice(k + 1)];
        if (pathLen(candidate) + 1 < pathLen(route)) {
          route = candidate;
          improved = true;
        }
      }
    }
  }
  const order = route.slice(1) as RouteStop[];
  return { order, totalMeters: pathLen(route) };
}

export const DEFAULT_GEOFENCE_METERS = 200;
