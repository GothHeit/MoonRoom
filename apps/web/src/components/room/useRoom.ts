"use client";

import type { components } from "@app/api-client";
import { errorCode } from "@app/api-client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { api } from "@/lib/api";
import type { StreamChoice } from "@/lib/watch-target";

import { useServerClock } from "./clock";
import { expectedPosition, newer, type LocalEvent, type Playback } from "./sync";

export type RoomState = components["schemas"]["RoomOut"];
export type ChatMessage = {
  id: string;
  user_id: string;
  username: string;
  text: string;
  reaction: boolean;
};
/** Something that happened in the room, shown as a quiet line between the messages. */
export type RoomEvent =
  | { kind: "joined" | "left" | "played"; name: string }
  | { kind: "paused" | "jumped"; name: string; position: number }
  | { kind: "episode"; episode: number };
export type ChatLine = ChatMessage | (RoomEvent & { id: string; event: true });
/** A reaction someone just sent, floating over the video for a moment. */
export type Floating = { id: string; emoji: string; username: string };
/** `closed` carries why: the room ended, is full, or the session is gone. */
export type Status = "connecting" | "open" | { closed: "room_not_found" | "room_full" | "not_authenticated" | "network" };

const CHAT_LIMIT = 100;
/** How long a new message stays over the video while the chat is closed, and a reaction floats. */
const TOAST_MS = 6000;
const FLOAT_MS = 2400;
/** Joining replays the chat history right after the first snapshot; this soon after it is history. */
const HISTORY_MS = 300;
/** A playback change that moves the room further than this is someone jumping. */
const JUMP_SECONDS = 2;
/** Someone gone for less than this (a reload, a restart) isn't announced as leaving. */
const LEAVE_GRACE_MS = 8000;
/** The server sends a tick every 10 s; this long without anything and the stream is stuck. */
const SILENT_MS = 25_000;
/** Back from the background after this long, the connection is opened afresh. */
const AWAY_MS = 3000;
/** While the server is unreachable (a restart, a deploy) the room keeps trying this long. */
const GIVE_UP_MS = 120_000;
const RETRY_MS = [1000, 2000, 4000, 8000];
const ENDED = ["room_not_found", "room_full", "not_authenticated"] as const;

function playbackOf(state: RoomState["playback"]): Playback {
  return { playing: state.playing, position: state.position, at: state.at, version: state.version };
}

/** Joins a room over server-sent events and keeps its state, chat and playback up to date. */
export function useRoom(initial: RoomState, onError?: (code: string) => void) {
  const errorHandler = useRef(onError);
  useEffect(() => {
    errorHandler.current = onError;
  });
  const code = initial.code;
  const [room, setRoom] = useState(initial);
  const [playback, setPlayback] = useState(() => playbackOf(initial.playback));
  const clock = useServerClock();
  const measureClock = clock.measure;
  const [messages, setMessages] = useState<ChatLine[]>([]);
  const [status, setStatus] = useState<Status>("connecting");
  // Whether the room was ever reached, so a later "connecting" reads as reconnecting.
  const [reached, setReached] = useState(false);
  const [reactions, setReactions] = useState<Floating[]>([]);
  const [toasts, setToasts] = useState<ChatMessage[]>([]);

  useEffect(() => {
    let revision = initial.revision;
    let version = initial.playback.version;
    let heard = Date.now();
    let hiddenAt: number | null = null;
    let stopped = false;
    // Since when the server has been out of reach, and the pending retry.
    let unreachableSince: number | null = null;
    let retries = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const later = (ms: number, run: () => void) => {
      const id = setTimeout(() => {
        timers.delete(id);
        run();
      }, ms);
      timers.add(id);
    };
    // Who is in the room and what it plays, to tell what changed when news arrives.
    // Null until the first snapshot, which only seeds it: those people were there already.
    let names: Map<string, string> | null = null;
    let episode = initial.episode;
    let last = playbackOf(initial.playback);
    // When this connection's first snapshot arrived; the history follows it at once.
    let snapshotAt: number | null = null;
    const leaving = new Set<string>();
    let lines = 0;

    const note = (event: RoomEvent) => {
      const line = { ...event, id: `event-${++lines}`, event: true as const };
      setMessages((list) => [...list, line].slice(-CHAT_LIMIT));
    };

    const applyState = (state: RoomState) => {
      if (state.revision < revision) return;
      revision = state.revision;
      version = Math.max(version, state.playback.version);
      const now = new Map(state.members.map((m) => [m.id, m.username]));
      const before = names ?? now;
      for (const [id, name] of now) {
        // Back within the grace (a reload, a server restart): they never really left.
        if (!before.has(id) && !leaving.delete(id)) note({ kind: "joined", name });
      }
      for (const [id, name] of before) {
        if (now.has(id) || leaving.has(id)) continue;
        leaving.add(id);
        later(LEAVE_GRACE_MS, () => leaving.delete(id) && note({ kind: "left", name }));
      }
      names = now;
      if (state.episode !== episode) note({ kind: "episode", episode: state.episode });
      episode = state.episode;
      if (state.playback.version > last.version) last = playbackOf(state.playback);
      setRoom(state);
      setPlayback((current) => newer(current, playbackOf(state.playback)));
    };

    /** Says who played, paused or jumped, from a playback change that names who did it. */
    const describe = (data: RoomState["playback"]) => {
      const before = last;
      if (data.version <= before.version) return;
      last = playbackOf(data);
      const name = data.by ? names?.get(data.by) : undefined;
      if (!name) return;
      const jumped = Math.abs(data.position - expectedPosition(before, data.at)) > JUMP_SECONDS;
      if (data.playing && !before.playing) note({ kind: "played", name });
      else if (!data.playing && before.playing) note({ kind: "paused", name, position: data.position });
      else if (jumped) note({ kind: "jumped", name, position: data.position });
    };

    /** Asks for the whole room again, when the stream seems to have missed something. */
    const refetch = () =>
      void api
        .GET("/watch/rooms/{code}", { params: { path: { code } } })
        .then(({ data }) => data && !stopped && applyState(data))
        .catch(() => undefined);

    const open = () => {
      const es = new EventSource(`/api/proxy/watch/rooms/${encodeURIComponent(code)}/events`);
      const on = <T,>(name: string, handler: (data: T) => void) =>
        es.addEventListener(name, (event) => {
          heard = Date.now();
          handler(JSON.parse((event as MessageEvent<string>).data) as T);
        });

      es.onopen = () => {
        heard = Date.now();
        unreachableSince = null;
        retries = 0;
        snapshotAt = null;
        setStatus("open");
        setReached(true);
      };
      on<RoomState>("state", (state) => {
        snapshotAt ??= Date.now();
        applyState(state);
      });
      on<RoomState["playback"]>("playback", (data) => {
        version = Math.max(version, data.version);
        describe(data);
        setPlayback((current) => newer(current, playbackOf(data)));
      });
      on<{ version: number; revision: number }>("tick", (tick) => {
        if (tick.revision > revision || tick.version > version) refetch();
      });
      on<ChatMessage>("chat", (message) => {
        if (message.reaction) {
          setReactions((list) => [...list, { id: message.id, emoji: message.text, username: message.username }].slice(-12));
          later(FLOAT_MS, () => setReactions((list) => list.filter((r) => r.id !== message.id)));
          return;
        }
        // A reconnect replays the history, so a message may arrive twice.
        setMessages((list) => (list.some((m) => m.id === message.id) ? list : [...list, message].slice(-CHAT_LIMIT)));
        if (snapshotAt === null || Date.now() - snapshotAt < HISTORY_MS) return;
        setToasts((list) => (list.some((m) => m.id === message.id) ? list : [...list, message].slice(-3)));
        later(TOAST_MS, () => setToasts((list) => list.filter((m) => m.id !== message.id)));
      });
      es.onerror = () => {
        // The browser retries a dropped connection on its own. It gives up (CLOSED) when the
        // server refused it, so ask why.
        if (es.readyState !== EventSource.CLOSED) {
          setStatus("connecting");
          return;
        }
        if (es !== source || stopped) return;
        // The room is gone or refused us: say so. Anything else (the server restarting, a bad
        // gateway, no network) is worth waiting out: the room comes back after a restart.
        const retry = () => {
          unreachableSince ??= Date.now();
          if (Date.now() - unreachableSince > GIVE_UP_MS) {
            setStatus({ closed: "network" });
            return;
          }
          setStatus("connecting");
          retryTimer = setTimeout(reopen, RETRY_MS[Math.min(retries++, RETRY_MS.length - 1)]);
        };
        void api
          .GET("/watch/rooms/{code}", { params: { path: { code } } })
          .then(({ error }) => {
            if (stopped) return;
            const reason = errorCode(error);
            const ended = ENDED.find((e) => e === reason);
            if (ended) setStatus({ closed: ended });
            else retry();
          })
          .catch(() => !stopped && retry());
      };
      return es;
    };

    let source = open();
    // Opens the new connection before closing the old one, so the others never see a leave.
    const reopen = () => {
      const old = source;
      heard = Date.now();
      source = open();
      old.close();
    };

    const watchdog = setInterval(() => {
      if (source.readyState === EventSource.OPEN && Date.now() - heard > SILENT_MS) reopen();
    }, 5000);
    // A phone that slept (an iPhone PWA in the background) comes back to a dead connection and a
    // clock that may have moved: start both afresh instead of waiting for the browser's retry.
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        hiddenAt = Date.now();
        return;
      }
      const away = hiddenAt !== null && Date.now() - hiddenAt > AWAY_MS;
      hiddenAt = null;
      if (!away || source.readyState === EventSource.CLOSED) return;
      void measureClock();
      reopen();
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      stopped = true;
      clearTimeout(retryTimer);
      source.close();
      clearInterval(watchdog);
      document.removeEventListener("visibilitychange", onVisibility);
      for (const id of timers) clearTimeout(id);
    };
    // The initial snapshot only seeds the counters; the stream follows the code.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, measureClock]);

  const path = useMemo(() => ({ params: { path: { code } } }), [code]);

  /** Runs a room action and reports a refusal (openapi-fetch returns errors instead of throwing). */
  const report = useCallback(async (call: Promise<{ error?: unknown }>) => {
    try {
      const result = await call;
      if (result.error) errorHandler.current?.(errorCode(result.error));
    } catch {
      errorHandler.current?.("network");
    }
  }, []);

  const send = useCallback(
    (action: LocalEvent, position: number) =>
      api.POST("/watch/rooms/{code}/control", { ...path, body: { action, position } }).catch(() => undefined),
    [path],
  );
  const setBuffering = useCallback(
    (buffering: boolean) =>
      api.POST("/watch/rooms/{code}/buffering", { ...path, body: { buffering } }).catch(() => undefined),
    [path],
  );
  const say = useCallback(
    (text: string) => report(api.POST("/watch/rooms/{code}/chat", { ...path, body: { text } })),
    [path, report],
  );
  const react = useCallback(
    (emoji: string) => api.POST("/watch/rooms/{code}/reaction", { ...path, body: { emoji } }).catch(() => undefined),
    [path],
  );
  const voteEpisode = useCallback(
    (episode: number) => report(api.POST("/watch/rooms/{code}/episode", { ...path, body: { episode } })),
    [path, report],
  );
  const withdrawVote = useCallback(
    () => report(api.DELETE("/watch/rooms/{code}/episode", path)),
    [path, report],
  );
  const switchStream = useCallback(
    (to: StreamChoice) => report(api.PUT("/watch/rooms/{code}/stream", { ...path, body: to })),
    [path, report],
  );
  const setLocked = useCallback(
    (locked: boolean) => report(api.PUT("/watch/rooms/{code}/lock", { ...path, body: { locked } })),
    [path, report],
  );

  return {
    room,
    playback,
    serverNow: clock.serverNow,
    clockReady: clock.ready,
    clock,
    messages,
    status,
    reconnecting: reached && status === "connecting",
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
  };
}
