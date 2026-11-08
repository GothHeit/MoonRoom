"use client";

import { useEffect, type ReactNode } from "react";

import { usePathname, useRouter } from "@/i18n/navigation";

import { isBack } from "./keys";
import { NAV_KEY, setFocus } from "./spatial";

const TOP_LEVEL = ["/tv", "/tv/search", "/tv/list", "/tv/settings"];

type TvWindow = Window & {
  tizen?: { application?: { getCurrentApplication?: () => { exit: () => void } } };
  webOS?: { platformBack?: () => void };
};

/** Leaves the TV app when it runs inside a TV wrapper; a plain browser has nowhere to go. */
function exitApp() {
  const w = window as TvWindow;
  try {
    if (w.tizen?.application?.getCurrentApplication) w.tizen.application.getCurrentApplication().exit();
    else w.webOS?.platformBack?.();
  } catch {
    // Not inside a TV wrapper.
  }
}

/**
 * The TV mode's frame: lays the screen out at 1920x1080 (every size is in rem, and the root size
 * scales with the screen) and gives Back the meaning it has on TV apps: a title page goes back
 * where it came from; a top-level screen first moves focus to the top bar, then goes Home; Back
 * on Home's top bar leaves the app.
 */
export function TvRoot({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (!isBack(event)) return;
      // The PIN screen handles Back itself (it goes to the account picker).
      if (document.querySelector("[data-tv-pin]")) return;
      event.preventDefault();
      const inNav = !!document.activeElement?.closest("[data-tv-nav]");
      if (pathname === "/tv/login") {
        exitApp();
      } else if (pathname === "/tv/accounts") {
        // The first screen leaves the app; reached from Settings, Back returns there.
        if (new URLSearchParams(window.location.search).has("back")) router.back();
        else exitApp();
      } else if (!TOP_LEVEL.includes(pathname)) {
        if (window.history.length > 1) router.back();
        else router.replace("/tv");
      } else if (!inNav) {
        setFocus(NAV_KEY);
      } else if (pathname !== "/tv") {
        router.replace("/tv");
      } else {
        exitApp();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pathname, router]);

  useEffect(() => {
    // The TV keyboard shrinks the viewport while typing; keep the scale of the largest size seen so
    // the whole UI doesn't shrink with it.
    let width = 0;
    let height = 0;
    const apply = () => {
      width = Math.max(width, window.innerWidth);
      height = Math.max(height, window.innerHeight);
      document.documentElement.style.fontSize = `${Math.min(width / 120, height / 67.5)}px`;
    };
    apply();
    window.addEventListener("resize", apply);
    return () => {
      window.removeEventListener("resize", apply);
      document.documentElement.style.fontSize = "";
    };
  }, []);

  return (
    <div data-tv className="min-h-dvh [--tv-x:5rem]">
      {/* 16px at 1920x1080; the page never shows a scrollbar, the remote does the scrolling. */}
      <style>{"html{font-size:min(calc(100vw / 120),calc(100vh / 67.5));scrollbar-width:none}html::-webkit-scrollbar{display:none}"}</style>
      {children}
    </div>
  );
}
