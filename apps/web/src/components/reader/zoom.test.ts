import { describe, expect, it } from "vitest";

import { clampZoom, fittedSize, isDoubleTap, NO_ZOOM, pinch, toggleZoom, zoomAt } from "./zoom";

const view = { w: 400, h: 800 };
const page = { w: 400, h: 600 };

describe("clampZoom", () => {
  it("snaps back to the whole page near scale 1", () => {
    expect(clampZoom({ scale: 1.02, x: 30, y: 30 }, view, page)).toEqual(NO_ZOOM);
    expect(clampZoom({ scale: 0.5, x: 0, y: 0 }, view, page)).toEqual(NO_ZOOM);
  });
  it("keeps the zoomed page covering the view", () => {
    // At 2x the page is 800 by 1200: it may pan 200 sideways and 200 up or down.
    expect(clampZoom({ scale: 2, x: 500, y: -500 }, view, page)).toEqual({ scale: 2, x: 200, y: -200 });
    // Smaller than the view in one direction: centred there.
    expect(clampZoom({ scale: 1.2, x: 90, y: 90 }, view, page)).toEqual({ scale: 1.2, x: 40, y: 0 });
  });
  it("caps the scale", () => {
    expect(clampZoom({ scale: 9, x: 0, y: 0 }, view, page).scale).toBe(4);
  });
});

describe("zoomAt", () => {
  it("keeps the point under the finger still", () => {
    const origin = { x: 100, y: -50 };
    const zoomed = zoomAt(NO_ZOOM, 2, origin);
    // The page point that was at `origin` (100, -50 from the centre) now maps to the same screen spot.
    expect(zoomed.scale).toBe(2);
    expect(origin.x * zoomed.scale + zoomed.x).toBe(origin.x);
    expect(origin.y * zoomed.scale + zoomed.y).toBe(origin.y);
  });
  it("follows the fingers in a pinch", () => {
    const start = { x: 0, y: 0 };
    const out = pinch(NO_ZOOM, 100, start, 200, { x: 10, y: 20 });
    expect(out).toEqual({ scale: 2, x: 10, y: 20 });
  });
});

describe("toggleZoom", () => {
  it("zooms in on the spot, and back out", () => {
    const zoomed = toggleZoom(NO_ZOOM, { x: 50, y: 50 });
    expect(zoomed.scale).toBe(2.5);
    expect(toggleZoom(zoomed, { x: 0, y: 0 })).toEqual(NO_ZOOM);
  });
});

describe("isDoubleTap", () => {
  it("needs two quick taps on the same spot", () => {
    expect(isDoubleTap({ t: 0, x: 0, y: 0 }, { t: 200, x: 10, y: 10 })).toBe(true);
    expect(isDoubleTap({ t: 0, x: 0, y: 0 }, { t: 400, x: 10, y: 10 })).toBe(false);
    expect(isDoubleTap({ t: 0, x: 0, y: 0 }, { t: 200, x: 100, y: 10 })).toBe(false);
    expect(isDoubleTap(null, { t: 200, x: 0, y: 0 })).toBe(false);
  });
});

describe("fittedSize", () => {
  it("fits the page inside the view keeping its shape", () => {
    expect(fittedSize({ w: 1000, h: 1500 }, view)).toEqual({ w: 400, h: 600 });
    expect(fittedSize({ w: 1000, h: 500 }, view)).toEqual({ w: 400, h: 200 });
    expect(fittedSize({ w: 0, h: 0 }, view)).toEqual(view);
  });
});
