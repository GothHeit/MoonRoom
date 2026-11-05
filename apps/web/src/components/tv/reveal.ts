"use client";

// Keeps the focused item in view the way TV apps do: rows slide sideways only when the item would
// leave the screen, and the page scrolls so the focused row sits under the top bar.

const EDGE = 0.04; // of the screen width: the safe margin rows keep on both sides
const TOP = 0.16; // of the screen height: where a focused row's top lands

function behavior(): ScrollBehavior {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
}

export function revealHorizontally(node: HTMLElement) {
  const scroller = node.closest<HTMLElement>("[data-tv-scroller]");
  if (!scroller) return;
  const box = node.getBoundingClientRect();
  const frame = scroller.getBoundingClientRect();
  const margin = window.innerWidth * EDGE;
  let delta = 0;
  if (box.right > frame.right - margin) delta = box.right - (frame.right - margin);
  else if (box.left < frame.left + margin) delta = box.left - (frame.left + margin);
  if (delta !== 0) scroller.scrollBy({ left: delta, behavior: behavior() });
}

export function revealVertically(node: HTMLElement) {
  // The block to keep whole on screen: a row with its title, the episodes with their heading.
  const section = node.closest<HTMLElement>("[data-tv-section]");
  // The first block (the hero, a title's header) keeps the page at the very top.
  if (section?.dataset.tvSection === "top") {
    window.scrollTo({ top: 0, behavior: behavior() });
    return;
  }
  const height = window.innerHeight;
  const top = height * TOP;
  const box = section?.getBoundingClientRect();
  if (box && box.height <= height - top) {
    // Rows land at the same height every time, so the eye always knows where to look.
    window.scrollTo({ top: Math.max(0, window.scrollY + box.top - top), behavior: behavior() });
    return;
  }
  // Anything else (a grid, a settings line) only moves when it would leave the screen.
  const item = node.getBoundingClientRect();
  const bottom = height * (1 - EDGE);
  if (item.top < top) window.scrollBy({ top: item.top - top, behavior: behavior() });
  else if (item.bottom > bottom) window.scrollBy({ top: item.bottom - bottom, behavior: behavior() });
}

export function reveal(node: HTMLElement | null | undefined) {
  if (!node) return;
  revealHorizontally(node);
  revealVertically(node);
}
