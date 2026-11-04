"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState, type RefObject } from "react";

import { PlayerIcon } from "@/components/player/icons";

import type { SyncStats } from "./useRoomSync";

type Props = {
  /** The browser refused to start the video until the viewer taps. */
  blocked: boolean;
  onUnblock: () => void;
  /** The player's controls are showing; the source notice comes and goes with them. */
  controlsShown: boolean;
  /** Set when this viewer's video comes from another source than the room's. */
  otherSource?: { room: string; onMove?: () => void };
  /** Set to show the sync numbers (the room page opened with ?debug=sync). */
  debug?: { stats: RefObject<SyncStats>; offset: () => number; rtt: () => number | null };
};

/** What a room viewer may need to see over the video: a tap to start, a source mismatch, sync numbers. */
export function RoomNotices({ blocked, onUnblock, controlsShown, otherSource, debug }: Props) {
  const t = useTranslations("player");
  const [dismissed, setDismissed] = useState(false);
  return (
    <>
      {blocked && (
        <div className="absolute inset-0 z-20 flex items-center justify-center p-6">
          <div className="flex max-w-sm flex-col items-center gap-3 rounded-ui border border-line bg-surface p-6 text-center">
            <button
              type="button"
              onClick={onUnblock}
              className="press min-h-11 rounded-full bg-accent px-6 py-2.5 text-sm font-bold text-on-accent"
            >
              {t("roomTapToJoin")}
            </button>
            <p className="text-sm text-muted">{t("roomTapHint")}</p>
          </div>
        </div>
      )}
      {otherSource && !dismissed && (
        // Fades with the player's controls and can be closed, so it never sits over the video.
        <div
          role="status"
          aria-hidden={!controlsShown}
          className={`absolute left-4 right-4 top-20 z-10 flex items-center gap-2 rounded-ui border border-line bg-surface py-1.5 pl-4 pr-1.5 text-sm transition-opacity duration-160 ease-out motion-reduce:transition-none sm:left-8 sm:right-auto sm:max-w-xl ${controlsShown ? "opacity-100" : "pointer-events-none opacity-0"}`}
        >
          <p className="min-w-0 flex-1 text-soft">{t("roomOtherSource", { room: otherSource.room })}</p>
          {otherSource.onMove && (
            <button
              type="button"
              tabIndex={controlsShown ? 0 : -1}
              onClick={otherSource.onMove}
              className="press min-h-11 shrink-0 rounded-full border border-line-strong px-4 py-2 text-xs font-bold hover:bg-line"
            >
              {t("roomMoveEveryone")}
            </button>
          )}
          <button
            type="button"
            tabIndex={controlsShown ? 0 : -1}
            onClick={() => setDismissed(true)}
            aria-label={t("roomDismiss")}
            className="press flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-muted hover:bg-line hover:text-fg"
          >
            <PlayerIcon name="close" />
          </button>
        </div>
      )}
      {debug && <SyncDebug {...debug} />}
    </>
  );
}

function SyncDebug({ stats, offset, rtt }: NonNullable<Props["debug"]>) {
  const t = useTranslations("player");
  const [, redraw] = useState(0);
  useEffect(() => {
    const id = setInterval(() => redraw((n) => n + 1), 500);
    return () => clearInterval(id);
  }, []);
  // Read on each redraw: the numbers live in refs that change without rendering.
  const s = stats.current;
  const trip = rtt();
  const lines = [
    t("syncDrift", { ms: s.drift === null ? "-" : Math.round(s.drift * 1000) }),
    t("syncClock", { ms: Math.round(offset()) }),
    t("syncRtt", { ms: trip === null ? "-" : Math.round(trip) }),
    t("syncRate", { rate: s.rate.toFixed(3) }),
    `v${s.version}`,
  ];
  return (
    <div
      aria-label={t("syncDebug")}
      className="pointer-events-none absolute left-4 top-24 z-10 rounded-ui border border-line bg-surface px-3 py-2 font-mono text-xs tabular-nums text-soft"
    >
      {lines.map((line) => (
        <p key={line}>{line}</p>
      ))}
    </div>
  );
}
