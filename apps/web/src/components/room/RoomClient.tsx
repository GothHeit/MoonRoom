"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

import { Player, type Lang } from "@/components/player/Player";
import { PlayerIcon } from "@/components/player/icons";
import type { SubtitleStyle } from "@/components/player/subtitleStyle";
import { useToast } from "@/components/ui/Toast";
import { Link } from "@/i18n/navigation";

import { RoomPanel } from "./RoomPanel";
import { useRoom, type RoomState } from "./useRoom";

const ACTION_ERRORS = [
  "room_not_found",
  "controls_locked",
  "host_only",
  "invalid_episode",
  "empty_message",
  "network",
  "not_in_room",
  "source_not_found",
  "not_authenticated",
];

type Props = {
  initial: RoomState;
  meId: string;
  episodes: number[];
  subtitleLang: string | null;
  subtitleStyle: SubtitleStyle;
};

export function RoomClient({ initial, meId, episodes, subtitleLang, subtitleStyle }: Props) {
  const t = useTranslations("room");
  const toast = useToast();
  const {
    room,
    playback,
    messages,
    status,
    lastReaction,
    send,
    setBuffering,
    say,
    react,
    voteEpisode,
    withdrawVote,
    setLocked,
    switchStream,
  } = useRoom(initial, (code) => {
    // A locked room already shows its own toast through the control events.
    if (code === "controls_locked") return;
    toast(t(`actionErrors.${ACTION_ERRORS.includes(code) ? code : "unknown"}`), "error");
  });
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState(0);
  const unread = open ? 0 : messages.length - seen;

  if (typeof status === "object") {
    return (
      <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black p-6 text-fg">
        <div role="alert" className="max-w-md text-center">
          <p className="text-lg font-medium">{t(`closed.${status.closed}`)}</p>
          <Link href="/room" className="mt-6 press inline-flex min-h-11 items-center justify-center rounded-full bg-accent px-5 py-2 text-sm font-bold text-on-accent">
            {t("back")}
          </Link>
        </div>
      </div>
    );
  }

  function toggle() {
    if (open) setSeen(messages.length);
    setOpen(!open);
  }

  const canControl = !room.locked || room.host_id === meId;
  const topBar = (
    <button
      type="button"
      onClick={toggle}
      aria-expanded={open}
      aria-label={t("togglePanel", { count: room.members.length })}
      className="relative ml-auto flex h-10 items-center gap-2 rounded-ui px-3 text-fg hover:bg-white/10"
    >
      <PlayerIcon name="people" />
      <span className="text-sm font-bold tabular-nums">{room.members.length}</span>
      {unread > 0 && (
        <span className="absolute -right-1 -top-1 rounded-full bg-accent px-1.5 text-xs font-bold text-on-accent">
          {unread}
        </span>
      )}
    </button>
  );

  const waitingFor = room.members.filter((m) => room.buffering.includes(m.id)).map((m) => m.username);
  const overlay = (
    <>
      {waitingFor.length > 0 && (
        <p
          role="status"
          className="pointer-events-none absolute left-1/2 top-24 -translate-x-1/2 rounded-ui bg-black/80 px-4 py-2 text-sm font-medium"
        >
          {t("waitingFor", { names: waitingFor.join(", ") })}
        </p>
      )}
      {open && (
        <div className="absolute inset-y-20 right-4 z-10 w-[min(22rem,calc(100%-2rem))] sm:right-8">
          <RoomPanel
            room={room}
            meId={meId}
            messages={messages}
            episodes={episodes}
            onSay={(text) => void say(text)}
            onReact={(emoji) => void react(emoji)}
            onVote={(episode) => void voteEpisode(episode)}
            onWithdraw={() => void withdrawVote()}
            onLock={(locked) => void setLocked(locked)}
          />
        </div>
      )}
      {lastReaction && (
        <div
          key={lastReaction.id}
          role="status"
          className="pointer-events-none absolute bottom-32 left-4 rounded-ui bg-black/70 px-3 py-2 text-2xl sm:left-8"
        >
          {lastReaction.text}
          <span className="ml-2 text-xs text-muted">{lastReaction.username}</span>
        </div>
      )}
    </>
  );

  return (
    <Player
      key={`${room.source}-${room.anime_id}-${room.episode}-${room.lang}`}
      source={room.source}
      animeId={room.anime_id}
      episode={room.episode}
      title={room.title}
      episodes={episodes}
      lang={room.lang as Lang}
      startAt={0}
      subtitleLang={subtitleLang}
      subtitleStyle={subtitleStyle}
      room={{
        playback,
        canControl,
        send,
        setBuffering,
        pickEpisode: (episode) => void voteEpisode(episode),
        switchStream: room.host_id === meId ? switchStream : undefined,
        onLocked: () => toast(t("locked"), "error"),
        topBar,
        overlay,
      }}
    />
  );
}
