"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import type { StreamChoice } from "@/lib/watch-target";

import { APPLY_WINDOW_MS, commandFor, correction, type LocalEvent, type Playback, type VideoState } from "./sync";

export type RoomBinding = {
  playback: Playback;
  /** The server's time now, by this device's clock and its measured offset (epoch ms). */
  serverNow: () => number;
  /** False until the clock has been measured once; nothing is steered on a guessed clock. */
  clockReady: () => boolean;
  /** False when the host locked the controls and this viewer isn't the host. */
  canControl: boolean;
  send: (action: LocalEvent, position: number) => unknown;
  /** Tells the room this viewer's video is stuck loading (true) or playing again (false). */
  setBuffering: (buffering: boolean) => unknown;
  /** The viewer asked for another episode: a vote, or an order when they host. */
  pickEpisode: (episode: number) => unknown;
  /** Moves everyone to another source or between sub and dub. Only set for the host. */
  switchStream?: (to: StreamChoice) => unknown;
  /** Called when a locked viewer tries to control the video. */
  onLocked: () => void;
  /** Shows the sync numbers over the video, for checking a real device. */
  debug?: { offset: () => number; rtt: () => number | null };
  /** Rendered in the player's top bar, after the title. */
  topBar: ReactNode;
  /** Where the player sits on the screen (classes); unset fills it. The room shrinks it for its panel. */
  frame?: string;
  /** Rendered over the video, outside the controls that fade away. */
  overlay: ReactNode;
};

/** What the sync needs from the player's <video>, so the hook never touches the element. */
export type VideoControls = {
  /** The playhead and play state, or null while there is nothing to sync (no metadata yet). */
  read: () => VideoState | null;
  seek: (seconds: number) => void;
  /** Resolves once playing; rejects when the browser wants a tap first. */
  play: () => Promise<void>;
  pause: () => void;
  setRate: (rate: number) => void;
};

/** What the debug overlay shows. */
export type SyncStats = { drift: number | null; rate: number; seekCost: number; version: number };

const TICK_MS = 250;
/** A stall shorter than this is a seek or a hiccup, not worth pausing everyone for. */
const STALL_MS = 700;
/** Seeks are assumed to take this long until this player has shown how long its own take. */
const FIRST_SEEK_COST = 0.15;
const MAX_SEEK_COST = 1;
/** After the viewer's own action, the room's answer is awaited this long before steering again. */
const ANSWER_MS = 2500;

/**
 * Keeps a player in step with a room: works out where the room is right now on the server's
 * clock, steers the video there (gently by speed, by a jump only when far off, starting at the
 * scheduled moment), and turns the viewer's own play, pause and seek into commands. Without a
 * room it does nothing.
 */
export function useRoomSync(video: VideoControls, room: RoomBinding | undefined) {
  const latest = useRef(room);
  const controls = useRef(video);
  const ignoreUntil = useRef(0);
  const lastSeekAt = useRef(0);
  const seekStartedAt = useRef<number | null>(null);
  const seekCost = useRef(FIRST_SEEK_COST);
  const startTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const stats = useRef<SyncStats>({ drift: null, rate: 1, seekCost: FIRST_SEEK_COST, version: 0 });
  // The browser refused to start without a tap (iPhone Safari, mostly).
  const [blocked, setBlocked] = useState(false);
  const blockedRef = useRef(false);
  // The viewer just acted and the room hasn't answered yet: don't pull them back meanwhile.
  const awaiting = useRef<{ version: number; until: number } | null>(null);

  useEffect(() => {
    latest.current = room;
    controls.current = video;
  });

  const startPlaying = useCallback(() => {
    if (blockedRef.current) return;
    controls.current.play().catch((error: unknown) => {
      if (error instanceof DOMException && error.name === "NotAllowedError") {
        blockedRef.current = true;
        setBlocked(true);
      }
    });
  }, []);

  const apply = useCallback(() => {
    const current = latest.current;
    // Before the metadata is in there is nothing to seek yet; loadedmetadata calls this again.
    const state = controls.current.read();
    if (!state || !current || !current.clockReady()) return;
    const now = Date.now();
    const wait = awaiting.current;
    if (wait && current.playback.version <= wait.version && now < wait.until) return;
    awaiting.current = null;
    const serverNow = current.serverNow();
    const fix = correction(current.playback, state, serverNow, {
      now,
      lastSeekAt: lastSeekAt.current,
      seekCost: seekCost.current,
    });
    const expected = current.playback.playing
      ? current.playback.position + Math.max(serverNow - current.playback.at, 0) / 1000
      : current.playback.position;
    stats.current = {
      drift: state.seeking ? null : state.currentTime - expected,
      rate: state.playbackRate,
      seekCost: seekCost.current,
      version: current.playback.version,
    };
    if (!fix) return;
    if (fix.seekTo !== null || fix.play !== null) ignoreUntil.current = now + APPLY_WINDOW_MS;
    if (fix.rate !== null) controls.current.setRate(fix.rate);
    if (fix.seekTo !== null) {
      lastSeekAt.current = now;
      seekStartedAt.current = now;
      controls.current.seek(Math.max(fix.seekTo, 0));
    }
    if (fix.play === false) controls.current.pause();
    if (fix.play === true) startPlaying();
    clearTimeout(startTimer.current);
    if (fix.startIn !== null) {
      // Start on the moment itself, not on the next tick.
      startTimer.current = setTimeout(() => {
        ignoreUntil.current = Date.now() + APPLY_WINDOW_MS;
        startPlaying();
      }, Math.max(fix.startIn, 0));
    }
  }, [startPlaying]);

  const playback = room?.playback;
  useEffect(() => {
    if (playback) apply();
  }, [playback, apply]);

  const inRoom = room !== undefined;
  useEffect(() => {
    if (!inRoom) return;
    const id = setInterval(apply, TICK_MS);
    return () => {
      clearInterval(id);
      clearTimeout(startTimer.current);
    };
  }, [inRoom, apply]);

  // Reports a stall once it lasts, and the recovery after it. The room decides whether it
  // matters: a paused room ignores it.
  const stallTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const reported = useRef(false);

  const onWaiting = useCallback(() => {
    clearTimeout(stallTimer.current);
    stallTimer.current = setTimeout(() => {
      const current = latest.current;
      if (!current || reported.current) return;
      reported.current = true;
      void current.setBuffering(true);
    }, STALL_MS);
  }, []);

  const onReady = useCallback(() => {
    clearTimeout(stallTimer.current);
    if (!reported.current) return;
    reported.current = false;
    void latest.current?.setBuffering(false);
  }, []);

  useEffect(() => () => clearTimeout(stallTimer.current), []);

  const local = useCallback(
    (event: LocalEvent) => {
      const current = latest.current;
      const state = controls.current.read();
      if (!current || !state || Date.now() < ignoreUntil.current) return;
      const command = commandFor(event, current.playback, state.currentTime, current.serverNow());
      if (!current.canControl) {
        // Not allowed: undo what the viewer just did.
        if (command) current.onLocked();
        apply();
        return;
      }
      if (!command) {
        apply();
        return;
      }
      awaiting.current = { version: current.playback.version, until: Date.now() + ANSWER_MS };
      current.send(command.action, command.position);
      if (command.action === "play" && !state.paused) {
        // The room schedules the start a moment ahead for everyone; wait for it here too.
        ignoreUntil.current = Date.now() + APPLY_WINDOW_MS;
        controls.current.pause();
      }
    },
    [apply],
  );

  const onSeeked = useCallback(() => {
    if (seekStartedAt.current !== null) {
      // Our own jump landing, however long it took: never the viewer's seek, so it must not
      // move the room. Its time tells the next jump how far ahead to aim.
      const took = (Date.now() - seekStartedAt.current) / 1000;
      seekCost.current = Math.min(MAX_SEEK_COST, seekCost.current * 0.6 + took * 0.4);
      seekStartedAt.current = null;
      return;
    }
    local("seek");
  }, [local]);

  /** The viewer tapped "join": a tap lets the browser start, and the room takes it from there. */
  const unblock = useCallback(() => {
    blockedRef.current = false;
    setBlocked(false);
    ignoreUntil.current = Date.now() + APPLY_WINDOW_MS;
    // Inside the tap itself, so the browser allows it; apply() then moves it to the right spot.
    controls.current
      .play()
      .then(() => apply())
      .catch(() => {
        blockedRef.current = true;
        setBlocked(true);
      });
  }, [apply]);

  return {
    onPlay: () => local("play"),
    onPause: () => local("pause"),
    onSeeked,
    onLoadedMetadata: apply,
    onWaiting,
    onReady,
    blocked,
    unblock,
    stats,
  };
}
