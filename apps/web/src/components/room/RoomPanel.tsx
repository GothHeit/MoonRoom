"use client";

import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";

import { Switch } from "@/components/account/Switch";
import { PlayerIcon } from "@/components/player/icons";
import { formatTime } from "@/components/player/progress";

import type { ChatLine, RoomState } from "./useRoom";
import { InviteFriends } from "./InviteFriends";
import { votesNeeded } from "./sync";

export const REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🔥"];

export type PanelTab = "chat" | "people" | "episode";
const TABS: PanelTab[] = ["chat", "people", "episode"];

type Props = {
  room: RoomState;
  meId: string;
  messages: ChatLine[];
  episodes: number[];
  tab: PanelTab;
  onTab: (tab: PanelTab) => void;
  onSay: (text: string) => void;
  onReact: (emoji: string) => void;
  onVote: (episode: number) => void;
  onWithdraw: () => void;
  onLock: (locked: boolean) => void;
};

const AVATARS = ["bg-poster-1", "bg-poster-2", "bg-poster-3", "bg-poster-4"];

/** A round initial, in one of the flat poster shades picked from the person's id. */
export function Avatar({ id, name, small = false }: { id: string; name: string; small?: boolean }) {
  let hash = 0;
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return (
    <span
      aria-hidden="true"
      className={`flex shrink-0 items-center justify-center rounded-full font-bold text-fg ${AVATARS[Math.abs(hash) % AVATARS.length]} ${small ? "h-7 w-7 text-xs" : "h-9 w-9 text-sm"}`}
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

/** The room's side panel: chat, the people in the room and the episode, as tabs. */
export function RoomPanel({ room, meId, messages, episodes, tab, onTab, onSay, onReact, onVote, onWithdraw, onLock }: Props) {
  const t = useTranslations("room");
  return (
    <div className="flex h-full min-h-0 flex-col text-sm">
      <div role="tablist" aria-label={t("tabsLabel")} className="flex shrink-0 gap-1 border-b border-line p-2">
        {TABS.map((name) => (
          <button
            key={name}
            type="button"
            role="tab"
            id={`room-tab-${name}`}
            aria-selected={tab === name}
            aria-controls={`room-tabpanel-${name}`}
            onClick={() => onTab(name)}
            className={`press min-h-11 flex-1 rounded-full px-3 text-sm ${tab === name ? "bg-line font-bold text-fg" : "text-soft hover:text-fg"}`}
          >
            {t(`tabs.${name}`)}
            {name === "people" && <span className="ml-1.5 tabular-nums text-muted">{room.members.length}</span>}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`room-tabpanel-${tab}`}
        aria-labelledby={`room-tab-${tab}`}
        className="flex min-h-0 flex-1 flex-col"
      >
        {tab === "chat" && <Chat meId={meId} messages={messages} onSay={onSay} onReact={onReact} />}
        {tab === "people" && <People room={room} meId={meId} onLock={onLock} />}
        {tab === "episode" && (
          <Episode room={room} meId={meId} episodes={episodes} onVote={onVote} onWithdraw={onWithdraw} />
        )}
      </div>
    </div>
  );
}

function Chat({
  meId,
  messages,
  onSay,
  onReact,
}: Pick<Props, "meId" | "messages" | "onSay" | "onReact">) {
  const t = useTranslations("room");
  const [text, setText] = useState("");
  const log = useRef<HTMLOListElement>(null);
  const pinned = useRef(true);

  // New lines keep the newest in view, unless the viewer scrolled up to read.
  useEffect(() => {
    const el = log.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const value = text.trim();
    if (!value) return;
    onSay(value);
    setText("");
    pinned.current = true;
  }

  return (
    <>
      <ol
        ref={log}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
        aria-live="polite"
        aria-label={t("chat")}
        className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain px-4 py-3"
      >
        {/* Pushes a short conversation to the bottom, next to the box. */}
        <li aria-hidden="true" className="mt-auto" />
        {messages.length === 0 && <li className="text-center text-muted">{t("noMessages")}</li>}
        {messages.map((m) =>
          "event" in m ? (
            <li key={m.id} className="text-center text-xs text-muted">
              {m.kind === "episode"
                ? t("events.episode", { episode: m.episode })
                : t(`events.${m.kind}`, {
                    name: m.name,
                    time: "position" in m ? formatTime(m.position) : "",
                  })}
            </li>
          ) : (
            <li key={m.id} className="flex items-start gap-2.5">
              <Avatar id={m.user_id} name={m.username} small />
              <p className="min-w-0 break-words pt-1 leading-snug">
                <span className={`mr-1.5 font-bold ${m.user_id === meId ? "text-accent" : "text-soft"}`}>{m.username}</span>
                {m.text}
              </p>
            </li>
          ),
        )}
      </ol>
      <div className="shrink-0 border-t border-line p-2">
        <div className="flex gap-0.5" role="group" aria-label={t("reactions")}>
          {REACTIONS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              onClick={() => onReact(emoji)}
              className="press flex h-11 w-11 items-center justify-center rounded-full text-xl hover:bg-line"
            >
              {emoji}
            </button>
          ))}
        </div>
        <form onSubmit={submit} className="mt-1 flex items-center gap-1 rounded-full border border-line-strong bg-bg py-1 pl-4 pr-1">
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={300}
            aria-label={t("message")}
            placeholder={t("message")}
            enterKeyHint="send"
            className="min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted"
          />
          <button
            type="submit"
            aria-label={t("send")}
            className="press flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent text-on-accent pointer-coarse:h-11 pointer-coarse:w-11"
          >
            <PlayerIcon name="send" />
          </button>
        </form>
      </div>
    </>
  );
}

function People({ room, meId, onLock }: Pick<Props, "room" | "meId" | "onLock">) {
  const t = useTranslations("room");
  const [copied, setCopied] = useState(false);
  const isHost = room.host_id === meId;

  async function copy() {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${window.location.pathname}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be refused; the code is on screen to read out.
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto overscroll-contain p-4">
      <section>
        <h2 className="font-sans text-sm font-bold">{t("members", { count: room.members.length })}</h2>
        <ul className="mt-3 flex flex-col gap-3">
          {room.members.map((m) => (
            <li key={m.id} className="flex items-center gap-3">
              <Avatar id={m.id} name={m.username} />
              <span className="min-w-0 flex-1 truncate">
                {m.username}
                {m.id === meId && <span className="ml-1.5 text-muted">({t("you")})</span>}
              </span>
              {room.buffering.includes(m.id) && <span className="text-xs text-muted">{t("loadingVideo")}</span>}
              {m.id === room.host_id && (
                <span className="rounded-full border border-line-strong px-2.5 py-0.5 text-xs font-bold text-accent">
                  {t("host")}
                </span>
              )}
            </li>
          ))}
        </ul>
        {isHost && (
          <label className="mt-4 flex min-h-11 items-center justify-between gap-3 border-t border-line pt-3">
            <span>{t("lockControls")}</span>
            <Switch checked={room.locked} onChange={onLock} label={t("lockControls")} />
          </label>
        )}
        {!isHost && room.locked && <p className="mt-4 text-muted">{t("lockedByHost")}</p>}
      </section>

      <section className="flex flex-col gap-3 border-t border-line pt-5">
        <h2 className="font-sans text-sm font-bold">{t("shareTitle")}</h2>
        <p className="text-muted">{t("shareHint")}</p>
        <div className="flex flex-wrap items-center gap-3">
          <span className="sr-only">{t("code")}</span>
          <span className="text-2xl font-bold tracking-widest tabular-nums" data-testid="room-code">
            {room.code}
          </span>
          <button
            type="button"
            onClick={() => void copy()}
            className="press min-h-11 rounded-full border border-line-strong px-4 text-sm font-bold hover:bg-line"
          >
            {copied ? t("copied") : t("copyLink")}
          </button>
        </div>
        <InviteFriends code={room.code} memberIds={room.members.map((m) => m.id)} />
      </section>
    </div>
  );
}

function Episode({
  room,
  meId,
  episodes,
  onVote,
  onWithdraw,
}: Pick<Props, "room" | "meId" | "episodes" | "onVote" | "onWithdraw">) {
  const t = useTranslations("room");
  const [pick, setPick] = useState<number | null>(null);
  const isHost = room.host_id === meId;
  const needed = votesNeeded(room.members.length);
  const myVote = room.votes[meId];
  const wanted = pick ?? episodes.find((e) => e !== room.episode) ?? room.episode;

  const tally = new Map<number, number>();
  for (const episode of Object.values(room.votes)) tally.set(episode, (tally.get(episode) ?? 0) + 1);
  const outline = "press min-h-11 shrink-0 rounded-full border border-line-strong px-4 text-sm font-bold hover:bg-line";

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain p-4">
      <h2 className="font-display text-2xl leading-tight">{t("episode", { episode: room.episode })}</h2>
      {episodes.length > 1 && (
        <div className="flex items-center gap-2">
          <label className="min-w-0 flex-1">
            <span className="sr-only">{t("pickEpisode")}</span>
            <select
              value={wanted}
              onChange={(e) => setPick(Number(e.target.value))}
              className="min-h-11 w-full rounded-full border border-line-strong bg-bg px-4 text-base"
            >
              {episodes.map((e) => (
                <option key={e} value={e}>
                  {t("episode", { episode: e })}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={wanted === room.episode}
            onClick={() => onVote(wanted)}
            className="press min-h-11 shrink-0 rounded-full bg-accent px-5 text-sm font-bold text-on-accent disabled:opacity-50"
          >
            {isHost ? t("switchNow") : t("propose")}
          </button>
        </div>
      )}
      {[...tally].map(([episode, count]) => (
        <div key={episode} className="flex items-center justify-between gap-3" aria-live="polite">
          <span>{t("votes", { episode, count, needed })}</span>
          {myVote === episode ? (
            <button type="button" onClick={onWithdraw} className={outline}>
              {t("withdraw")}
            </button>
          ) : (
            <button type="button" onClick={() => onVote(episode)} className={outline}>
              {t("voteFor")}
            </button>
          )}
        </div>
      ))}
      {!isHost && <p className="text-muted">{t("voteHint")}</p>}
    </div>
  );
}
