"use client";

import { doesFocusableExist, FocusContext, getCurrentFocusKey, useFocusable } from "@noriginmedia/norigin-spatial-navigation";
import { useEffect, type ReactNode } from "react";

import { usePathname } from "@/i18n/navigation";

import { NAV_KEY, PAGE_KEY, recallFocus, setFocus } from "./spatial";

// How long the screen waits for its `initial` item to stream in before settling for the first one.
const INITIAL_WAIT_TRIES = 15;
// How long a screen with nothing to focus waits before handing focus to the top bar.
const EMPTY_WAIT_TRIES = 5;

type Props = {
  /** The item to focus on arrival (the Play pill, the search field). */
  initial?: string;
  className?: string;
  /** No top bar above it (the sign-in screen): no room kept for one. */
  bare?: boolean;
  children: ReactNode;
};

/**
 * A TV screen's content. On arrival focus goes to the item the person left from (after Back),
 * else to `initial`, else to the first item, as soon as the content has streamed in, unless the
 * person already moved it. A screen with nothing to focus (an empty list) hands focus to the top
 * bar, so the remote never goes dead; if items stream in later, focus still moves down to them.
 */
export function TvPage({ initial, className = "", bare = false, children }: Props) {
  const { ref, focusKey } = useFocusable<object, HTMLDivElement>({ focusKey: PAGE_KEY, trackChildren: true });
  const screen = usePathname();

  useEffect(() => {
    const start = getCurrentFocusKey();
    let tries = 0;
    // The top-bar item focus was parked on while the page had nothing to focus.
    let parked: string | undefined;
    const attempt = () => {
      // Someone pressed an arrow while the page was loading: leave their focus alone.
      const now = getCurrentFocusKey();
      if (tries > 0 && now !== start && now !== PAGE_KEY && now !== parked) return true;
      const saved = recallFocus(screen);
      if (saved) {
        void setFocus(saved);
        return true;
      }
      if (initial && doesFocusableExist(initial)) {
        void setFocus(initial);
        return true;
      }
      if (initial && tries < INITIAL_WAIT_TRIES) return false;
      // The first item in page order (registration order can differ when parts stream in).
      const first = ref.current?.querySelector<HTMLElement>("[data-tv-key]")?.dataset.tvKey;
      if (!first) {
        if (!parked && !bare && tries >= EMPTY_WAIT_TRIES && doesFocusableExist(NAV_KEY)) {
          void setFocus(NAV_KEY);
          parked = getCurrentFocusKey();
        }
        return false;
      }
      void setFocus(first);
      return true;
    };
    if (attempt()) return;
    const timer = window.setInterval(() => {
      tries += 1;
      if (attempt() || tries > 80) window.clearInterval(timer);
    }, 100);
    return () => window.clearInterval(timer);
  }, [screen, initial, bare, ref]);

  return (
    <FocusContext.Provider value={focusKey}>
      <div ref={ref} className={`${bare ? "" : "mt-[7.5rem] pb-24"} ${className}`}>
        {children}
      </div>
    </FocusContext.Provider>
  );
}
