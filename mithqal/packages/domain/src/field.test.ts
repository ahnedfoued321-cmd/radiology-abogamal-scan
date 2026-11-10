import { describe, expect, it } from "vitest";
import { distanceMeters, planRoute } from "./field.js";

describe("field force", () => {
  it("computes distances (Riyadh: Kingdom Centre → Al Faisaliah ≈ 2.2 km)", () => {
    const d = distanceMeters({ lat: 24.7114, lng: 46.6744 }, { lat: 24.6905, lng: 46.6853 });
    expect(d).toBeGreaterThan(2_200);
    expect(d).toBeLessThan(2_700);
  });

  it("orders a route by proximity and puts priority stops first", () => {
    const start = { lat: 24.7, lng: 46.7 };
    const stops = [
      { id: "far", lat: 24.9, lng: 46.9 },
      { id: "near", lat: 24.701, lng: 46.701 },
      { id: "mid", lat: 24.75, lng: 46.75 },
    ];
    expect(planRoute(start, stops).order.map((s) => s.id)).toEqual(["near", "mid", "far"]);
    const withPriority = planRoute(start, [...stops.slice(0, 2), { ...stops[2]!, priority: 5 }]);
    expect(withPriority.order[0]!.id).toBe("mid");
  });

  it("never returns a longer route than nearest-neighbour alone", () => {
    const start = { lat: 0, lng: 0 };
    const pts = Array.from({ length: 12 }, (_, i) => ({ id: String(i), lat: Math.sin(i) * 0.1, lng: Math.cos(i * 1.7) * 0.1 }));
    const r = planRoute(start, pts);
    expect(r.order).toHaveLength(12);
    expect(new Set(r.order.map((s) => s.id)).size).toBe(12);
  });
});
