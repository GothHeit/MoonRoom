"use client";

import { useTranslations } from "next-intl";

import { useCountdown } from "@/components/room/RoomOverlay";
import { Avatar } from "@/components/room/RoomPanel";
import type { Playback } from "@/components/room/sync";
import type { ChatMessage, Floating } from "@/components/room/useRoom";

type Props = {
  playback: Playback;
  serverNow: () => number;
  /** New chat messages; the TV has no chat panel, so this is where they are read. */
  toasts: ChatMessage[];
  reactions: Floating[];
  reconnecting: boolean;
  waitingFor: string[];
  /** Short lines about the room right now: a vote under way, a refused action. */
  notes: string[];
};

const PILL = "flex min-h-14 items-center gap-4 rounded-full border border-line-strong bg-surface px-7 text-[1.5rem]";

/**
 * What the room shows over the TV's picture, sized for the couch: who it waits for, the
 * countdown, friends' messages and reactions. It never takes the remote.
 */
export function TvRoomOverlay({ playback, serverNow, toasts, reactions, reconnecting, waitingFor, notes }: Props) {
  const t = useTranslations("room");
  const count = useCountdown(playback, serverNow);
  const lines = [...(waitingFor.length > 0 ? [t("waitingFor", { names: waitingFor.join(", ") })] : []), ...notes];
  return (
    <>
      {(reconnecting || lines.length > 0) && (
        <div className="pointer-events-none absolute inset-x-[var(--tv-x)] top-[11rem] z-10 flex flex-col items-center gap-3">
          {reconnecting && (
            <p role="status" className={PILL}>
              <span aria-hidden="true" className="h-7 w-7 animate-spin rounded-full border-[3px] border-line-strong border-t-accent" />
              {t("reconnecting")}
            </p>
          )}
          {lines.map((line) => (
            <p key={line} role="status" className={PILL}>
              {line}
            </p>
          ))}
        </div>
      )}

      {count !== null && (
        <div role="status" className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-5">
          <span
            key={count}
            className="pop-in flex h-[15rem] w-[15rem] items-center justify-center rounded-full border-2 border-line-strong bg-surface font-display text-[10rem] leading-none text-accent"
          >
            {count}
          </span>
          <span className="rounded-full bg-surface px-7 py-2.5 text-[1.5rem] text-soft">{t("countdown")}</span>
        </div>
      )}

      {toasts.length > 0 && (
        // Top left, under the title: clear of the subtitles and of the controls.
        <ol aria-label={t("chat")} className="pointer-events-none absolute left-[var(--tv-x)] top-[11rem] z-10 flex w-[34rem] flex-col gap-3">
          {toasts.map((m) => (
            <li key={m.id} className="pop-in flex origin-top-left items-start gap-4 rounded-ui border border-line bg-surface py-3.5 pl-4 pr-6 text-[1.5rem]">
              <span className="[&>span]:h-14 [&>span]:w-14 [&>span]:text-[1.5rem]">
                <Avatar id={m.user_id} name={m.username} />
              </span>
              <p className="min-w-0 break-words pt-2.5 leading-snug">
                <span className="mr-2.5 font-bold text-soft">{m.username}</span>
                {m.text}
              </p>
            </li>
          ))}
        </ol>
      )}

      <ul aria-hidden="true" className="pointer-events-none absolute bottom-[19rem] right-[var(--tv-x)] z-10 h-0 w-28">
        {reactions.map((r, i) => (
          <li
            key={r.id}
            // A little sideways spread, so several at once don't stack into one.
            style={{ right: `${(i % 3) * 1.75}rem` }}
            className="float-up absolute bottom-0 flex flex-col items-center gap-1.5"
          >
            <span className="flex h-20 w-20 items-center justify-center rounded-full border border-line-strong bg-surface text-[2.5rem]">{r.emoji}</span>
            <span className="max-w-40 truncate rounded-full bg-surface px-3.5 text-[1.25rem] text-soft">{r.username}</span>
          </li>
        ))}
      </ul>
    </>
  );
}
