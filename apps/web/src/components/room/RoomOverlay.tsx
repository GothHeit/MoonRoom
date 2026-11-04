"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

import { Avatar } from "./RoomPanel";
import type { Playback } from "./sync";
import type { ChatMessage, Floating } from "./useRoom";

/** A scheduled start further out than this gets a countdown; play and seek leads are shorter. */
const COUNTDOWN_FROM_MS = 1500;

type Props = {
  playback: Playback;
  serverNow: () => number;
  /** New messages to show over the video; empty while the chat is in view. */
  toasts: ChatMessage[];
  reactions: Floating[];
  reconnecting: boolean;
  waitingFor: string[];
};

/** What the room shows over the video: who it waits for, the countdown, new messages and reactions. */
export function RoomOverlay({ playback, serverNow, toasts, reactions, reconnecting, waitingFor }: Props) {
  const t = useTranslations("room");
  return (
    <>
      {(reconnecting || waitingFor.length > 0) && (
        <div className="pointer-events-none absolute inset-x-4 top-20 z-10 flex flex-col items-center gap-2">
          {reconnecting && (
            <p role="status" className="flex items-center gap-2.5 rounded-full border border-line-strong bg-surface px-4 py-2 text-sm">
              <span aria-hidden="true" className="h-4 w-4 animate-spin rounded-full border-2 border-line-strong border-t-accent" />
              {t("reconnecting")}
            </p>
          )}
          {waitingFor.length > 0 && (
            <p role="status" className="rounded-full border border-line-strong bg-surface px-4 py-2 text-sm">
              {t("waitingFor", { names: waitingFor.join(", ") })}
            </p>
          )}
        </div>
      )}

      <Countdown playback={playback} serverNow={serverNow} />

      {toasts.length > 0 && (
        <ol
          aria-label={t("chat")}
          className="pointer-events-none absolute bottom-32 left-4 z-10 flex w-[min(24rem,calc(100%-6rem))] flex-col gap-2 sm:left-8"
        >
          {toasts.map((m) => (
            <li
              key={m.id}
              className="pop-in flex origin-bottom-left items-start gap-2.5 rounded-ui border border-line bg-surface py-2 pl-2 pr-4 text-sm"
            >
              <Avatar id={m.user_id} name={m.username} small />
              <p className="min-w-0 break-words pt-1 leading-snug">
                <span className="mr-1.5 font-bold text-soft">{m.username}</span>
                {m.text}
              </p>
            </li>
          ))}
        </ol>
      )}

      <ul aria-hidden="true" className="pointer-events-none absolute bottom-44 right-4 z-10 h-0 w-16 sm:right-8">
        {reactions.map((r, i) => (
          <li
            key={r.id}
            // A little sideways spread, so several at once don't stack into one.
            style={{ right: `${(i % 3) * 14}px` }}
            className="float-up absolute bottom-0 flex flex-col items-center gap-0.5"
          >
            <span className="flex h-12 w-12 items-center justify-center rounded-full border border-line-strong bg-surface text-2xl">
              {r.emoji}
            </span>
            <span className="max-w-20 truncate rounded-full bg-surface px-2 text-xs text-soft">{r.username}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

/** 3, 2, 1 over the video before an episode starts, so nobody misses the first second. */
function Countdown({ playback, serverNow }: Pick<Props, "playback" | "serverNow">) {
  const t = useTranslations("room");
  const [left, setLeft] = useState<{ version: number; ms: number } | null>(null);

  useEffect(() => {
    if (!playback.playing || playback.at - serverNow() < COUNTDOWN_FROM_MS) return;
    const update = () => {
      const ms = playback.at - serverNow();
      setLeft({ version: playback.version, ms });
      if (ms <= 0) clearInterval(id);
    };
    const id = setInterval(update, 100);
    return () => clearInterval(id);
  }, [playback, serverNow]);

  if (!left || left.version !== playback.version || left.ms <= 0 || !playback.playing) return null;
  const n = Math.ceil(left.ms / 1000);
  return (
    <div role="status" className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-2">
      <span
        key={n}
        className="pop-in flex h-[clamp(7rem,22vw,11rem)] w-[clamp(7rem,22vw,11rem)] items-center justify-center rounded-full border border-line-strong bg-surface font-display text-[clamp(4.5rem,14vw,7.5rem)] leading-none text-accent"
      >
        {n}
      </span>
      <span className="rounded-full bg-surface px-4 py-1.5 text-sm text-soft">{t("countdown")}</span>
    </div>
  );
}
