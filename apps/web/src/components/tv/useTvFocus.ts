"use client";

import { useFocusable } from "@noriginmedia/norigin-spatial-navigation";
import { useEffect, useId } from "react";

import { usePathname } from "@/i18n/navigation";

import { reveal } from "./reveal";
import { rememberFocus } from "./spatial";

type Options = {
  focusKey?: string;
  onEnter?: () => void;
  /** Return false to keep focus where it is for that direction. */
  onArrow?: (direction: string) => boolean;
  onFocus?: () => void;
  /** Off for the top bar: Back should return to the content, not to a tab. */
  remember?: boolean;
};

/** A remote-focusable item: scrolls itself into view and is remembered for Back. */
export function useTvFocus<E extends HTMLElement>({ focusKey, onEnter, onArrow, onFocus, remember = true }: Options = {}) {
  const screen = usePathname();
  // Our own key when none is given, so the focus handler knows which item to remember.
  const fallback = `tv-${useId()}`;
  const key = focusKey ?? fallback;
  const result = useFocusable<object, E>({
    focusKey: key,
    onEnterPress: onEnter,
    onArrowPress: onArrow ? (direction) => onArrow(direction) : undefined,
    onFocus: (layout) => {
      if (remember) rememberFocus(screen, key);
      reveal(layout.node as HTMLElement | undefined);
      onFocus?.();
    },
  });
  // Lets a screen find its first item in page order (see TvPage).
  useEffect(() => {
    result.ref.current?.setAttribute("data-tv-key", key);
  }, [result.ref, key]);
  return result;
}
