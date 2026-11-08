"use client";

import { useEffect } from "react";

import { useRouter } from "@/i18n/navigation";
import { drain } from "@/lib/drain";

// A TV left alone this long asks for the PIN again. Never while something is playing.
const IDLE_MS = 20 * 60 * 1000;

function lockNow() {
  // keepalive: the page may be going to the background while this is sent.
  return fetch("/api/proxy/auth/pin/lock", { method: "POST", keepalive: true })
    .then(drain)
    .catch(() => undefined);
}

function somethingPlaying() {
  const video = document.querySelector("video");
  return !!video && !video.paused && !video.ended;
}

/**
 * Renders nothing. On a TV with a PIN it locks the session again when the app goes to the
 * background and after a long idle time, then reloads the server screens, which show the PIN
 * pad (coming back from the background goes to the account picker instead). Opening the app locks it too, but that happens on the server (see the TV layout).
 */
export function TvPinGuard() {
  const router = useRouter();

  useEffect(() => {
    let idle = 0;
    const relock = async () => {
      await lockNow();
      router.refresh();
    };
    const arm = () => {
      window.clearTimeout(idle);
      idle = window.setTimeout(function check() {
        if (somethingPlaying()) {
          idle = window.setTimeout(check, 60_000);
          return;
        }
        void relock();
      }, IDLE_MS);
    };
    const onVisibility = () => {
      if (document.hidden) void lockNow();
      // Back in front after the app was in the background: it is like opening it, so ask who is watching.
      else router.replace("/tv/accounts");
    };
    arm();
    window.addEventListener("keydown", arm);
    // A video starting counts as the viewer being there: the next episode starting on its own must
    // not lock the TV in the few seconds between episodes, when nothing is playing. Media events
    // don't bubble, so they are caught on the way down.
    document.addEventListener("playing", arm, true);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearTimeout(idle);
      window.removeEventListener("keydown", arm);
      document.removeEventListener("playing", arm, true);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [router]);

  return null;
}
