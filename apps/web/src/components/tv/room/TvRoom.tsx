"use client";

import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";

import { PlayerIcon } from "@/components/player/icons";
import type { SubtitleStyle } from "@/components/player/subtitleStyle";
import { votesNeeded } from "@/components/room/sync";
import { useRoom, type RoomState } from "@/components/room/useRoom";
import type { Lang } from "@/lib/watch-target";

import { TvPlayer } from "../player/TvPlayer";
import { TvRoomEnded } from "./TvRoomEnded";
import { TvRoomOverlay } from "./TvRoomOverlay";

const ACTION_ERRORS = ["room_not_found", "controls_locked", "host_only", "invalid_episode", "network", "not_in_room", "source_not_found", "not_authenticated"];
/** How long a refused action stays on screen. */
const NOTICE_MS = 5000;

type Props = {
  initial: RoomState;
  meId: string;
  episodes: number[];
  thumbnails: Record<string, string>;
  poster: string | null;
  subtitleLang: string | null;
  subtitleStyle: SubtitleStyle;
  showSkips: boolean;
};

/**
 * A watch-together room on the TV: the TV player kept in step with everyone else. The remote
 * plays, pauses and seeks for the whole room (unless the host locked it); friends' messages and
 * reactions show over the picture. Writing in the chat stays on the phone.
 */
export function TvRoom({ initial, meId, episodes, thumbnails, poster, subtitleLang, subtitleStyle, showSkips }: Props) {
  const t = useTranslations("room");
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const say = useCallback((text: string) => {
    setNotice(text);
    clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), NOTICE_MS);
  }, []);
  useEffect(() => () => clearTimeout(noticeTimer.current), []);

  const { room, playback, serverNow, clockReady, clock, status, reconnecting, reactions, toasts, send, setBuffering, reportPosition, voteEpisode, switchStream } = useRoom(
    initial,
    (code) => say(t(`actionErrors.${ACTION_ERRORS.includes(code) ? code : "unknown"}`)),
  );

  if (typeof status === "object") return <TvRoomEnded reason={status.closed} />;

  const host = room.host_id === meId;
  const canControl = !room.locked || host;
  const waitingFor = room.members.filter((m) => room.buffering.includes(m.id)).map((m) => m.username);

  // The TV has no panel for the vote, so the leading one is said over the picture.
  const tally = new Map<number, number>();
  for (const episode of Object.values(room.votes)) tally.set(episode, (tally.get(episode) ?? 0) + 1);
  const leading = [...tally].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
  const notes = [
    ...(leading ? [t("votes", { episode: leading[0], count: leading[1], needed: votesNeeded(room.members.length) })] : []),
    ...(notice ? [notice] : []),
  ];

  const topBar = (
    <p className="flex items-center gap-3 rounded-full bg-black/55 px-6 py-2.5 text-[1.5rem] font-bold text-fg [&_svg]:h-7 [&_svg]:w-7">
      <PlayerIcon name="people" />
      <span className="tabular-nums">{t("watching", { count: room.members.length })}</span>
      {!canControl && <span className="font-medium text-soft">{` · ${t("lockedByHost")}`}</span>}
    </p>
  );

  return (
    <TvPlayer
      key={`${room.source}-${room.anime_id}-${room.episode}-${room.lang}`}
      source={room.source}
      animeId={room.anime_id}
      episode={room.episode}
      title={room.title}
      episodes={episodes}
      thumbnails={thumbnails}
      poster={poster}
      lang={room.lang as Lang}
      startAt={0}
      subtitleLang={subtitleLang}
      subtitleStyle={subtitleStyle}
      showSkips={showSkips}
      room={{
        playback,
        serverNow,
        clockReady,
        canControl,
        send,
        setBuffering,
        peers: {
          report: reportPosition,
          trim: () => clock.trim.current / 1000,
          setTrim: clock.setTrim,
          rtt: () => clock.rtt.current,
        },
        pickEpisode: (episode) => void voteEpisode(episode),
        switchStream: host ? switchStream : undefined,
        onLocked: () => say(t("locked")),
        topBar,
        overlay: (
          <TvRoomOverlay
            playback={playback}
            serverNow={serverNow}
            toasts={toasts.filter((m) => m.user_id !== meId)}
            reactions={reactions}
            reconnecting={reconnecting}
            waitingFor={waitingFor}
            notes={notes}
          />
        ),
      }}
    />
  );
}
