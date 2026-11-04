"use client";

import { useTranslations } from "next-intl";
import { useState, useSyncExternalStore } from "react";

import { Player, type Lang } from "@/components/player/Player";
import { PlayerIcon } from "@/components/player/icons";
import type { SubtitleStyle } from "@/components/player/subtitleStyle";
import { useToast } from "@/components/ui/Toast";

import { RoomEnded } from "./RoomEnded";
import { RoomOverlay } from "./RoomOverlay";
import { Avatar, RoomPanel, type PanelTab } from "./RoomPanel";
import { useRoom, type ChatMessage, type RoomState } from "./useRoom";

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

/** A big landscape screen opens the room with the chat beside the video, as Twitch does. */
const WIDE = "(min-width: 1024px) and (orientation: landscape)";
function subscribeWide(onChange: () => void) {
  const query = window.matchMedia(WIDE);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

// Sideways (and on a computer) the panel is a column on the right that the video shrinks for;
// upright it sits under a 16:9 video, so the video is never covered.
// Written out in full so the class names are found at build time: side min(22.5rem,42vw),
// under the video at 16:9 of the width plus the notch.
const PLAYER_BESIDE_PANEL =
  "inset-0 landscape:right-[min(22.5rem,42vw)] portrait:bottom-auto portrait:h-[calc(56.25vw+env(safe-area-inset-top))]";
const PANEL =
  "landscape:inset-y-0 landscape:right-0 landscape:w-[min(22.5rem,42vw)] landscape:border-l landscape:pt-[env(safe-area-inset-top)] landscape:pr-[env(safe-area-inset-right)] portrait:inset-x-0 portrait:bottom-0 portrait:top-[calc(56.25vw+env(safe-area-inset-top))] portrait:border-t";

type Props = {
  initial: RoomState;
  meId: string;
  episodes: number[];
  subtitleLang: string | null;
  subtitleStyle: SubtitleStyle;
  showSkips: boolean;
  /** Show the sync numbers over the video (?debug=sync), for checking a phone or a TV by eye. */
  debug?: boolean;
};

export function RoomClient({ initial, meId, episodes, subtitleLang, subtitleStyle, showSkips, debug = false }: Props) {
  const t = useTranslations("room");
  const toast = useToast();
  const {
    room,
    playback,
    serverNow,
    clockReady,
    clock,
    messages,
    status,
    reconnecting,
    reactions,
    toasts,
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
  const wide = useSyncExternalStore(subscribeWide, () => window.matchMedia(WIDE).matches, () => false);
  // Null until the viewer opens or closes it: then the screen size decides.
  const [chosen, setChosen] = useState<boolean | null>(null);
  const [tab, setTab] = useState<PanelTab>("chat");
  const [seenId, setSeenId] = useState<string | null>(null);
  const open = chosen ?? wide;

  if (typeof status === "object") return <RoomEnded reason={status.closed} />;

  const chat = messages.filter((m): m is ChatMessage => !("event" in m));
  const reading = open && tab === "chat";
  const seenAt = seenId === null ? -1 : chat.findIndex((m) => m.id === seenId);
  const unread = reading ? 0 : chat.slice(seenAt + 1).filter((m) => m.user_id !== meId).length;
  const latest = chat.at(-1)?.id ?? null;

  /** Opens the panel on a tab, or closes it when that tab is already showing. */
  function show(next: PanelTab) {
    if (reading) setSeenId(latest);
    if (open && tab === next) {
      setChosen(false);
      return;
    }
    setTab(next);
    setChosen(true);
  }

  const canControl = !room.locked || room.host_id === meId;
  const pill = "press flex h-11 shrink-0 items-center gap-2 rounded-full text-sm font-bold";
  const topBar = (
    <div className="ml-auto flex shrink-0 items-center gap-2">
      <button
        type="button"
        onClick={() => show("people")}
        aria-pressed={open && tab === "people"}
        aria-label={t("peopleButton", { count: room.members.length })}
        className={`${pill} px-2 text-soft hover:text-fg`}
      >
        <span className="hidden -space-x-2 sm:flex short:hidden">
          {room.members.slice(0, 3).map((m) => (
            <span key={m.id} className="rounded-full ring-2 ring-black">
              <Avatar id={m.id} name={m.username} small />
            </span>
          ))}
        </span>
        <span className="sm:hidden short:inline">
          <PlayerIcon name="people" />
        </span>
        <span className="font-medium tabular-nums">
          <span className="sm:hidden short:inline">{room.members.length}</span>
          <span className="hidden sm:inline short:hidden">{t("watching", { count: room.members.length })}</span>
        </span>
      </button>
      <button
        type="button"
        onClick={() => show("people")}
        className={`${pill} hidden border border-line-strong px-4 text-fg hover:bg-line md:flex short:hidden`}
      >
        <PlayerIcon name="invite" />
        {t("inviteButton")}
      </button>
      <button
        type="button"
        onClick={() => show("chat")}
        aria-pressed={reading}
        aria-label={t("chatButtonLabel", { open: String(reading), count: unread })}
        className={`${pill} relative px-3 sm:px-4 short:px-3 ${reading ? "bg-accent text-on-accent" : "border border-line-strong text-fg hover:bg-line"}`}
      >
        <PlayerIcon name="chat" />
        <span className="hidden sm:inline short:hidden">{t("chatButton")}</span>
        {unread > 0 && (
          <span className="flex h-6 min-w-6 items-center justify-center rounded-full bg-accent px-1.5 text-xs font-bold tabular-nums text-on-accent max-sm:absolute max-sm:-right-1 max-sm:-top-1 short:absolute short:-right-1 short:-top-1">
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>
    </div>
  );

  const waitingFor = room.members.filter((m) => room.buffering.includes(m.id)).map((m) => m.username);
  const overlay = (
    <RoomOverlay
      playback={playback}
      serverNow={serverNow}
      // With the panel open the chat is a tap away, and on a phone the video is too small for them.
      toasts={open ? [] : toasts.filter((m) => m.user_id !== meId)}
      reactions={reactions}
      reconnecting={reconnecting}
      waitingFor={waitingFor}
    />
  );

  return (
    <>
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
        showSkips={showSkips}
        room={{
          playback,
          serverNow,
          clockReady,
          canControl,
          send,
          setBuffering,
          pickEpisode: (episode) => void voteEpisode(episode),
          switchStream: room.host_id === meId ? switchStream : undefined,
          onLocked: () => toast(t("locked"), "error"),
          debug: debug ? { offset: () => clock.offset.current, rtt: () => clock.rtt.current } : undefined,
          frame: open ? PLAYER_BESIDE_PANEL : undefined,
          topBar,
          overlay,
        }}
      />
      {open && (
        <aside
          aria-label={t("panel")}
          className={`fixed z-[60] flex flex-col border-line bg-surface pb-[env(safe-area-inset-bottom)] text-fg ${PANEL}`}
        >
          <RoomPanel
            room={room}
            meId={meId}
            messages={messages}
            episodes={episodes}
            tab={tab}
            onTab={(next) => {
              if (reading) setSeenId(latest);
              setTab(next);
            }}
            onSay={(text) => void say(text)}
            onReact={(emoji) => void react(emoji)}
            onVote={(episode) => void voteEpisode(episode)}
            onWithdraw={() => void withdrawVote()}
            onLock={(locked) => void setLocked(locked)}
          />
        </aside>
      )}
    </>
  );
}
