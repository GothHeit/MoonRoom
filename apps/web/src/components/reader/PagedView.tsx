"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import type { Direction } from "@/lib/manga";

import { swipeStep, zoneOf, type Zone } from "./navigation";
import { PageView } from "./PageView";
import {
  clampZoom,
  distance,
  fittedSize,
  isDoubleTap,
  isZoomed,
  midpoint,
  NO_ZOOM,
  pinch,
  toggleZoom,
  type Point,
  type Tap,
  type Zoom,
} from "./zoom";

type Props = {
  pages: string[];
  /** 0 to pages.length: the last index is the end of the chapter. */
  index: number;
  direction: Direction;
  onIndex: (index: number) => void;
  /** A tap, by where it landed. A tap on a zoomed page only ever toggles the controls. */
  onZone: (zone: Zone) => void;
  chapterEnd: ReactNode;
};

// How long a page takes to slide in.
const SLIDE_MS = 240;
// A finger that moves less than this is a tap.
const TAP_PX = 10;
// Dragging past the first or last page pulls against this much resistance.
const EDGE_DRAG = 0.3;
// Letting go this far across commits the turn even without a flick.
const COMMIT_FRACTION = 0.3;
// A click this soon after a touch is the same tap, already handled.
const TOUCH_CLICK_MS = 500;

type Drag = { x: number; y: number; t: number; axis: "x" | "y" | null; zoom: Zoom };
type Pinch = { zoom: Zoom; distance: number; mid: Point };

const point = (touch: Touch): Point => ({ x: touch.clientX, y: touch.clientY });

/**
 * The pages side by side on a track: the one being read in the middle, its neighbours either
 * side of it (so they are already loaded) in reading order. A page turn slides the track; a
 * finger can drag it and let go. Two fingers zoom the page in the middle, a double tap in the
 * middle of it zooms too, and one finger then pans; the zoom is dropped on the next turn.
 */
export function PagedView({ pages, index, direction, onIndex, onZone, chapterEnd }: Props) {
  const count = pages.length;
  const sign = direction === "rtl" ? -1 : 1;
  const root = useRef<HTMLDivElement>(null);
  const slides = useRef<Map<number, HTMLDivElement>>(new Map());
  // The index the track is centred on; `index` can be one ahead while the turn is animating.
  const [shown, setShown] = useState(index);
  // Where the track is, in slide widths, and whether it glides there or jumps.
  const [offset, setOffset] = useState(0);
  const [glide, setGlide] = useState(false);
  const [zoom, setZoomState] = useState<Zoom>(NO_ZOOM);
  const [zoomGlide, setZoomGlide] = useState(false);
  const zoomRef = useRef<Zoom>(NO_ZOOM);
  const drag = useRef<Drag | null>(null);
  const pinching = useRef<Pinch | null>(null);
  const lastTap = useRef<Tap | null>(null);
  const lastTouch = useRef(0);
  const reduced = useRef(false);

  useEffect(() => {
    reduced.current = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }, []);

  const setZoom = useCallback((next: Zoom, animated: boolean) => {
    zoomRef.current = next;
    setZoomGlide(animated);
    setZoomState(next);
  }, []);

  // A new index from outside (a tap, a key, the slider, a drag let go): slide to a neighbour,
  // jump anywhere else. The zoom belongs to the page that was zoomed.
  useEffect(() => {
    if (index === shown) return;
    const diff = index - shown;
    const land = () => {
      setGlide(false);
      setShown(index);
      setOffset(0);
      setZoom(NO_ZOOM, false);
    };
    if (Math.abs(diff) !== 1 || reduced.current) {
      land();
      return;
    }
    setGlide(true);
    setOffset(-sign * diff);
    const timer = setTimeout(land, SLIDE_MS);
    return () => clearTimeout(timer);
  }, [index, shown, sign, setZoom]);

  /** The view and the page in it, for keeping a zoomed page on screen. */
  const bounds = useCallback(
    (next: Zoom) => {
      const el = root.current;
      if (!el) return next;
      const view = { w: el.clientWidth, h: el.clientHeight };
      const img = slides.current.get(shown)?.querySelector("img");
      const content = img && img.naturalWidth > 0 ? fittedSize({ w: img.naturalWidth, h: img.naturalHeight }, view) : view;
      return clampZoom(next, view, content);
    },
    [shown],
  );

  /** A point on screen as an offset from the view's centre, which the zoom is about. */
  const fromCentre = useCallback((p: Point): Point => {
    const el = root.current;
    if (!el) return p;
    const rect = el.getBoundingClientRect();
    return { x: p.x - rect.left - rect.width / 2, y: p.y - rect.top - rect.height / 2 };
  }, []);

  const tapped = useCallback(
    (at: Point, target: EventTarget | null, now: number) => {
      const el = root.current;
      if (!el || (target instanceof Element && target.closest("a, button, input, label"))) return;
      const zoomed = isZoomed(zoomRef.current);
      const zone: Zone = zoomed ? "toggle" : zoneOf((at.x - el.getBoundingClientRect().left) / el.clientWidth, direction);
      const tap = { t: now, ...at };
      if (isDoubleTap(lastTap.current, tap) && (zoomed || zone === "toggle")) {
        // The first tap already toggled the controls: put them back and zoom instead.
        lastTap.current = null;
        onZone("toggle");
        setZoom(bounds(toggleZoom(zoomRef.current, fromCentre(at))), true);
        return;
      }
      lastTap.current = tap;
      onZone(zone);
    },
    [direction, onZone, setZoom, bounds, fromCentre],
  );

  // Touch handling is attached by hand: React's touch listeners are passive, and a pinch or a
  // sideways drag must stop the browser from scrolling or zooming the whole app.
  useEffect(() => {
    const el = root.current;
    if (!el) return;

    function onStart(e: TouchEvent) {
      if (e.touches.length >= 2) {
        const [a, b] = [point(e.touches[0]), point(e.touches[1])];
        pinching.current = { zoom: zoomRef.current, distance: distance(a, b), mid: fromCentre(midpoint(a, b)) };
        drag.current = null;
        return;
      }
      if (pinching.current) return;
      const p = point(e.touches[0]);
      drag.current = { ...p, t: e.timeStamp, axis: null, zoom: zoomRef.current };
    }

    function onMove(e: TouchEvent) {
      const held = pinching.current;
      if (held && e.touches.length >= 2) {
        e.preventDefault();
        const [a, b] = [point(e.touches[0]), point(e.touches[1])];
        setZoom(bounds(pinch(held.zoom, held.distance, held.mid, distance(a, b), fromCentre(midpoint(a, b)))), false);
        return;
      }
      const d = drag.current;
      if (!d || e.touches.length !== 1) return;
      const p = point(e.touches[0]);
      const dx = p.x - d.x;
      const dy = p.y - d.y;
      if (isZoomed(d.zoom)) {
        e.preventDefault();
        d.axis = "x";
        setZoom(bounds({ ...d.zoom, x: d.zoom.x + dx, y: d.zoom.y + dy }), false);
        return;
      }
      if (d.axis === null && (Math.abs(dx) > TAP_PX || Math.abs(dy) > TAP_PX)) d.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
      if (d.axis !== "x") return;
      e.preventDefault();
      const width = el!.clientWidth || 1;
      const target = shown - sign * Math.sign(dx);
      const pull = target < 0 || target > count ? EDGE_DRAG : 1;
      setGlide(false);
      setOffset((dx / width) * pull);
    }

    function onEnd(e: TouchEvent) {
      lastTouch.current = e.timeStamp;
      if (pinching.current) {
        if (e.touches.length < 2) {
          pinching.current = null;
          setZoom(bounds(zoomRef.current), true);
        }
        return;
      }
      const d = drag.current;
      drag.current = null;
      if (!d) return;
      const p = point(e.changedTouches[0]);
      const dx = p.x - d.x;
      const dy = p.y - d.y;
      if (d.axis === null) {
        tapped(p, e.target, e.timeStamp);
        return;
      }
      if (isZoomed(d.zoom) || d.axis !== "x") return;
      const width = el!.clientWidth || 1;
      const flick = swipeStep(dx, dy, direction);
      const far = Math.abs(dx) > width * COMMIT_FRACTION ? -sign * Math.sign(dx) : 0;
      const delta = flick || far;
      const target = shown + delta;
      setGlide(true);
      if (delta !== 0 && target >= 0 && target <= count) onIndex(target);
      else setOffset(0);
    }

    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd);
    el.addEventListener("touchcancel", onEnd);
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onEnd);
    };
  }, [shown, count, sign, direction, onIndex, tapped, bounds, fromCentre, setZoom]);

  function onClick(e: React.MouseEvent) {
    // The click that follows a touch is the tap already handled above.
    if (e.timeStamp - lastTouch.current < TOUCH_CLICK_MS) return;
    tapped({ x: e.clientX, y: e.clientY }, e.target, e.timeStamp);
  }

  function onDoubleClick(e: React.MouseEvent) {
    if (e.timeStamp - lastTouch.current < TOUCH_CLICK_MS) return;
    if (e.target instanceof Element && e.target.closest("a, button, input, label")) return;
    const zone = zoneOf((e.clientX - e.currentTarget.getBoundingClientRect().left) / e.currentTarget.clientWidth, direction);
    if (!isZoomed(zoomRef.current) && zone !== "toggle") return;
    // The two clicks toggled the controls twice: nothing to undo.
    setZoom(bounds(toggleZoom(zoomRef.current, fromCentre({ x: e.clientX, y: e.clientY }))), true);
  }

  const visible = [shown - 1, shown, shown + 1].filter((i) => i >= 0 && i <= count);

  return (
    <div
      ref={root}
      role="presentation"
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      className={`relative h-full overflow-hidden ${isZoomed(zoom) ? "touch-none" : "touch-pan-y"}`}
      data-zoomed={isZoomed(zoom) || undefined}
    >
      <div
        className="absolute inset-0"
        style={{
          transform: `translate3d(${offset * 100}%, 0, 0)`,
          transition: glide ? `transform ${SLIDE_MS}ms cubic-bezier(0.22, 1, 0.36, 1)` : "none",
        }}
      >
        {visible.map((i) => (
          <div
            key={i}
            ref={(el) => {
              if (el) slides.current.set(i, el);
              else slides.current.delete(i);
            }}
            className="absolute inset-y-0 w-full"
            style={{ left: `${(i - shown) * sign * 100}%` }}
            aria-hidden={i !== shown || undefined}
          >
            {i === count ? (
              <div className="flex h-full items-center justify-center px-4">{chapterEnd}</div>
            ) : (
              <div
                className="h-full"
                style={
                  i === shown
                    ? {
                        transform: `translate3d(${zoom.x}px, ${zoom.y}px, 0) scale(${zoom.scale})`,
                        transition: zoomGlide ? "transform 200ms ease-out" : "none",
                        willChange: "transform",
                      }
                    : undefined
                }
              >
                <PageView src={pages[i]} page={i} priority={i === shown} />
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
