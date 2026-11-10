"use client";

import { init, setFocus, doesFocusableExist } from "@noriginmedia/norigin-spatial-navigation";

// Remote navigation for the TV mode: arrows move to the nearest item in that direction, Enter
// activates it. Started once, on the first import in the browser.
let started = false;

function startSpatialNavigation() {
  if (started || typeof window === "undefined") return;
  started = true;
  init({
    // The focused item also gets DOM focus, so screen readers and :focus styles follow it.
    shouldFocusDOMNode: true,
    // Scrolling is ours (reveal.ts): the browser's own jump on focus would fight it.
    domNodeFocusOptions: { preventScroll: true },
    // A held arrow repeats fast; slow TV chips can't lay out that many moves.
    throttle: 90,
    throttleKeypresses: true,
  });
}

startSpatialNavigation();

/** Where focus was on each screen, so Back lands on the card the person left from. */
const remembered = new Map<string, string>();

export function rememberFocus(screen: string, focusKey: string) {
  remembered.set(screen, focusKey);
}

export function recallFocus(screen: string): string | undefined {
  const key = remembered.get(screen);
  return key && doesFocusableExist(key) ? key : undefined;
}

export { setFocus };

export const NAV_KEY = "tv-nav";
export const PAGE_KEY = "tv-page";
