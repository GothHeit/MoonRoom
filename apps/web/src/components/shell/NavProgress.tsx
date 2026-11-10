"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

/** A navigation that never lands (a link that only opened a menu, say) stops the line after this long. */
const GIVE_UP_MS = 10_000;
/** How long the line takes to fade out once the new page is in. */
const FADE_MS = 320;

/** Where a plain left click on a link to another page of this site would go, else null. */
export function destinationOf(event: MouseEvent, here: string): string | null {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return null;
  const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
  if (!(link instanceof HTMLAnchorElement) || link.hasAttribute("download")) return null;
  if (link.target && link.target !== "_self") return null;
  const to = new URL(link.getAttribute("href") ?? "", here);
  const from = new URL(here);
  if (to.origin !== from.origin) return null;
  // The same page (a #section link, or the page we are on) loads nothing.
  if (to.pathname === from.pathname && to.search === from.search) return null;
  return to.pathname + to.search;
}

/**
 * A thin line across the top while the next page loads, so a tap is answered at once even on a
 * slow connection. It starts on a click on a link and ends when the address changes; quick
 * navigations finish before it ever shows (see `nav-progress` in globals.css).
 */
export function NavProgress() {
  const here = `${usePathname()}?${useSearchParams()}`;
  const [seen, setSeen] = useState(here);
  const [state, setState] = useState<"idle" | "loading" | "done">("idle");

  if (here !== seen) {
    setSeen(here);
    if (state === "loading") setState("done");
  }

  useEffect(() => {
    // Capture phase: the router's own click handler cancels the event before it bubbles up here.
    const onClick = (event: MouseEvent) => {
      if (destinationOf(event, window.location.href)) setState("loading");
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);

  useEffect(() => {
    if (state === "idle") return;
    const timer = setTimeout(() => setState("idle"), state === "done" ? FADE_MS : GIVE_UP_MS);
    return () => clearTimeout(timer);
  }, [state]);

  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-x-0 top-0 z-50 h-0.5">
      <div data-testid="nav-progress" data-state={state} className="nav-progress h-full origin-left bg-accent" />
    </div>
  );
}
