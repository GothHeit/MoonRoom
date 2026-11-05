"use client";

import { FocusContext, useFocusable } from "@noriginmedia/norigin-spatial-navigation";
import type { ReactNode } from "react";

type Props = {
  focusKey?: string;
  className?: string;
  /** The page's first block (hero, title header): focusing it scrolls to the very top. */
  top?: boolean;
  /** The item to land on the first time focus comes into the group. */
  preferred?: string;
  children: ReactNode;
};

/**
 * A block of focusable items (a row, a grid, a button bar). Coming back to it lands on the item
 * last focused there, so moving down and up again returns to the same card.
 */
export function TvGroup({ focusKey, className, top, preferred, children }: Props) {
  const { ref, focusKey: key } = useFocusable({ focusKey, saveLastFocusedChild: true, trackChildren: true, preferredChildFocusKey: preferred });
  return (
    <FocusContext.Provider value={key}>
      <div ref={ref} data-tv-section={top ? "top" : undefined} className={className}>
        {children}
      </div>
    </FocusContext.Provider>
  );
}
