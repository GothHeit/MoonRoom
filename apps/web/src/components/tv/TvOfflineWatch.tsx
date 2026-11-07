"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

import { isBack } from "./keys";

const CHECK_MS = 4000;
const FAILS_BEFORE_SHOWING = 2;
const LONG_OFFLINE_MS = 60_000;
const STARS = [
  [12, 22, 3, 0],
  [24, 68, 2, 1],
  [78, 30, 4, 2],
  [88, 72, 2, 0.5],
  [66, 16, 3, 3],
  [34, 14, 2, 1.7],
  [8, 52, 3, 2.4],
];

const PING_TIMEOUT_MS = 8000;

async function reachable() {
  // AbortSignal.timeout is missing from the Chromium 94 on older TVs.
  const abort = new AbortController();
  const timer = window.setTimeout(() => abort.abort(), PING_TIMEOUT_MS);
  try {
    const response = await fetch("/api/ping", {
      cache: "no-store",
      signal: abort.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    window.clearTimeout(timer);
  }
}

/** Leaves the TV app when it runs inside a TV wrapper. */
function exitApp() {
  const w = window as Window & {
    tizen?: {
      application?: { getCurrentApplication?: () => { exit: () => void } };
    };
  };
  try {
    w.tizen?.application?.getCurrentApplication?.().exit();
  } catch {
    // Not inside a TV wrapper.
  }
}

/**
 * Covers the TV with the moon when the site stops answering (a restart, or the server being off),
 * and reloads the page once it answers again. The page is already in the TV's memory, so this
 * works when nothing on the server can be reached.
 */
export function TvOfflineWatch() {
  const t = useTranslations("tv.offline");
  const [since, setSince] = useState<number | null>(null);
  const [long, setLong] = useState(false);
  const shown = since !== null;

  useEffect(() => {
    let fails = 0;
    let first = 0;
    let down = false;
    let stopped = false;
    let timer = 0;
    // One check at a time: the next waits for the last, so slow replies never pile up.
    const run = async () => {
      const ok = await reachable();
      if (stopped) return;
      if (ok) {
        if (down) {
          window.location.reload();
          return;
        }
        fails = 0;
      } else {
        fails += 1;
        if (fails === 1) first = Date.now();
        if (fails >= FAILS_BEFORE_SHOWING) {
          down = true;
          setSince(first);
          setLong(Date.now() - first > LONG_OFFLINE_MS);
        }
      }
      timer = window.setTimeout(run, CHECK_MS);
    };
    timer = window.setTimeout(run, CHECK_MS);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, []);

  // While the moon is up the screens under it must not react to the remote.
  useEffect(() => {
    if (!shown) return;
    const swallow = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (isBack(event)) exitApp();
    };
    window.addEventListener("keydown", swallow, true);
    return () => window.removeEventListener("keydown", swallow, true);
  }, [shown]);

  if (since === null) return null;
  return (
    <div
      role="status"
      className="moon-anim fixed inset-0 z-[100] flex flex-col items-center justify-center bg-bg text-center"
      style={{
        background:
          "radial-gradient(ellipse at 50% 45%, #2a1b4d 0, #150d26 70%)",
      }}
    >
      {STARS.map(([x, y, size, delay]) => (
        <span
          key={`${x}-${y}`}
          className="absolute rounded-full bg-fg opacity-15"
          style={{
            left: `${x}%`,
            top: `${y}%`,
            width: size,
            height: size,
            animation: `star-twinkle ${long ? 7 : 4}s ease-in-out ${delay}s infinite`,
          }}
        />
      ))}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/logo-lockup.svg"
        alt=""
        className="absolute top-[7vh] w-[26rem]"
      />
      <div
        className="relative mt-[4vh] aspect-square w-[22vh] overflow-hidden rounded-full bg-accent"
        style={{
          animation: `moon-glow ${long ? 12 : 6}s ease-in-out infinite`,
          opacity: long ? 0.75 : 1,
        }}
      >
        <i
          className="absolute rounded-full bg-bg"
          style={{
            top: "-2%",
            left: "-2%",
            width: "104%",
            height: "104%",
            animation: `moon-phase ${long ? 12 : 6}s ease-in-out infinite`,
          }}
        />
      </div>
      <h1 className="mt-[5vh] text-[3rem]">
        {long ? t("down") : t("reconnecting")}
      </h1>
      <p className="mt-[1vh] text-[1.75rem] text-soft">
        {long ? t("downBody") : t("reconnectingBody")}
      </p>
    </div>
  );
}
