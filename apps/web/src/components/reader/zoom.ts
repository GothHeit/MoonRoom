/** Pinch zoom on a page: a scale about the page's centre and a pan, in screen pixels. */
export type Zoom = { scale: number; x: number; y: number };
export type Size = { w: number; h: number };
export type Point = { x: number; y: number };

export const NO_ZOOM: Zoom = { scale: 1, x: 0, y: 0 };
export const MAX_SCALE = 4;
// What a double tap zooms to: enough to read small lettering.
export const DOUBLE_TAP_SCALE = 2.5;
// A scale this close to 1 is treated as no zoom, so the page snaps back whole.
const SNAP_BELOW = 1.04;

export const isZoomed = (zoom: Zoom) => zoom.scale > 1;

/**
 * Keeps the zoom in bounds: the scale between 1 and MAX_SCALE, and the pan such that the page
 * (`content`, its size at scale 1, centred in `view`) never leaves an edge of the view uncovered
 * when it is larger than the view, and stays centred when it is not.
 */
export function clampZoom(zoom: Zoom, view: Size, content: Size): Zoom {
  const scale = Math.min(Math.max(zoom.scale, 1), MAX_SCALE);
  if (scale < SNAP_BELOW) return NO_ZOOM;
  const limitX = Math.max(0, (content.w * scale - view.w) / 2);
  const limitY = Math.max(0, (content.h * scale - view.h) / 2);
  return {
    scale,
    x: Math.min(Math.max(zoom.x, -limitX), limitX),
    y: Math.min(Math.max(zoom.y, -limitY), limitY),
  };
}

/**
 * Scales by `factor` keeping the page point under `origin` (relative to the view's centre) where it
 * is on screen, as a pinch or a double tap expects.
 */
export function zoomAt(zoom: Zoom, factor: number, origin: Point): Zoom {
  const scale = Math.min(Math.max(zoom.scale * factor, 1), MAX_SCALE);
  const real = scale / zoom.scale;
  return {
    scale,
    x: origin.x - (origin.x - zoom.x) * real,
    y: origin.y - (origin.y - zoom.y) * real,
  };
}

/** Where a pinch that started at `start` has got to: scaled about its first midpoint, then dragged along with it. */
export function pinch(start: Zoom, startDistance: number, startMid: Point, distance: number, mid: Point): Zoom {
  const scaled = zoomAt(start, distance / Math.max(startDistance, 1), startMid);
  return { ...scaled, x: scaled.x + mid.x - startMid.x, y: scaled.y + mid.y - startMid.y };
}

/** What a double tap does: back to the whole page, or in on the spot that was tapped. */
export function toggleZoom(zoom: Zoom, at: Point): Zoom {
  return isZoomed(zoom) ? NO_ZOOM : zoomAt(NO_ZOOM, DOUBLE_TAP_SCALE, at);
}

// Two taps this close in time and space are one double tap.
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_PX = 40;

export type Tap = { t: number; x: number; y: number };

export function isDoubleTap(previous: Tap | null, tap: Tap) {
  return previous !== null && tap.t - previous.t < DOUBLE_TAP_MS && Math.hypot(tap.x - previous.x, tap.y - previous.y) < DOUBLE_TAP_PX;
}

export const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
export const midpoint = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/** The page's size when it is fitted whole into the view (object-fit: contain). */
export function fittedSize(natural: Size, view: Size): Size {
  if (natural.w <= 0 || natural.h <= 0) return view;
  const ratio = Math.min(view.w / natural.w, view.h / natural.h);
  return { w: natural.w * ratio, h: natural.h * ratio };
}
