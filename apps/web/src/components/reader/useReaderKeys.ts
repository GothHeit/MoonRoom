"use client";

import { useEffect } from "react";

import type { Direction } from "@/lib/manga";

import { stepFromKey } from "./navigation";

type Actions = {
  step: (delta: -1 | 1) => void;
  first: () => void;
  last: () => void;
  leave: () => void;
  toggleControls: () => void;
};

/** The keyboard shortcuts of the reader: arrows and Space page, Home/End jump, Escape leaves, H hides the bars. */
export function useReaderKeys(direction: Direction, enabled: boolean, actions: Actions) {
  const { step, first, last, leave, toggleControls } = actions;
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      if (e.key === "Escape") {
        leave();
        return;
      }
      if (!enabled) return;
      if (e.key === "Home") first();
      else if (e.key === "End") last();
      else if (e.key === "h") toggleControls();
      else {
        const delta = stepFromKey(e.key, direction);
        if (delta === 0) return;
        // A focused button answers Space itself.
        if (e.key === " " && (tag === "BUTTON" || tag === "A")) return;
        step(delta);
      }
      e.preventDefault();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [direction, enabled, step, first, last, leave, toggleControls]);
}
