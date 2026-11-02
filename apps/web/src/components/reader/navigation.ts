import type { Direction, ReadingSettings, ReadMode } from "@/lib/manga";

/** Which way a key moves through the chapter: +1 forward, -1 back, 0 not a paging key. */
export function stepFromKey(key: string, direction: Direction): -1 | 0 | 1 {
  switch (key) {
    case "ArrowRight":
      return direction === "rtl" ? -1 : 1;
    case "ArrowLeft":
      return direction === "rtl" ? 1 : -1;
    case " ":
    case "PageDown":
    case "ArrowDown":
      return 1;
    case "PageUp":
    case "ArrowUp":
    case "Backspace":
      return -1;
    default:
      return 0;
  }
}

export type Zone = "back" | "forward" | "toggle";

// The outer thirds page; the middle shows or hides the controls.
const SIDE = 0.35;

/** What a tap at `x` (0 to 1 across the page) does. The side that moves forward follows the reading direction. */
export function zoneOf(x: number, direction: Direction): Zone {
  if (x < SIDE) return direction === "rtl" ? "forward" : "back";
  if (x > 1 - SIDE) return direction === "rtl" ? "back" : "forward";
  return "toggle";
}

// A swipe has to be mostly sideways and long enough to be meant.
const SWIPE_MIN = 56;

/** Where a horizontal swipe goes: a finger moving left reveals the page on the right. */
export function swipeStep(dx: number, dy: number, direction: Direction): -1 | 0 | 1 {
  if (Math.abs(dx) < SWIPE_MIN || Math.abs(dx) < Math.abs(dy) * 1.5) return 0;
  const reveals: Direction = dx < 0 ? "ltr" : "rtl"; // the side revealed, named as the direction it is "next" for
  return reveals === direction ? 1 : -1;
}

export const clampPage = (index: number, count: number) => Math.min(Math.max(index, 0), Math.max(count - 1, 0));

const KEY = (mangaId: number) => `mr:reader:${mangaId}`;

function valid(value: unknown): value is Partial<ReadingSettings> {
  if (typeof value !== "object" || value === null) return false;
  const { mode, direction } = value as Record<string, unknown>;
  return (mode === undefined || mode === "page" || mode === "strip") && (direction === undefined || direction === "ltr" || direction === "rtl");
}

/** The reader settings saved for a title on this device, over the defaults. */
export function loadSettings(mangaId: number, defaults: ReadingSettings): ReadingSettings {
  try {
    const raw = localStorage.getItem(KEY(mangaId));
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return valid(parsed) ? { ...defaults, ...parsed } : defaults;
  } catch {
    return defaults;
  }
}

export function saveSettings(mangaId: number, settings: ReadingSettings) {
  try {
    localStorage.setItem(KEY(mangaId), JSON.stringify(settings));
  } catch {
    // private mode or full storage: the choice just doesn't stick
  }
}

export type { Direction, ReadMode };
