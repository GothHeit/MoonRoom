"use client";

import { useEffect, useRef } from "react";

import { sameStream } from "@/components/player/streams";
import type { StreamChoice } from "@/lib/watch-target";

import type { RoomBinding } from "./useRoomSync";

/** At most this many moves per episode, so two flaky sources can never bounce the room. */
const MAX_FOLLOWS = 3;
const follows = new Map<string, number>();
/** How long the player that the room reloads still tells the host why it moved. */
const TELL_MS = 15_000;
let lastMove: { key: string; failed: StreamChoice; playing: StreamChoice; at: number } | null = null;

/** The room's latest move away from a stream that couldn't play this episode, if it just happened. */
export function recentFollow(animeId: number, episode: number) {
  const move = lastMove;
  if (!move || move.key !== `${animeId}-${episode}` || Date.now() - move.at > TELL_MS) return null;
  return { failed: move.failed, playing: move.playing };
}

type Args = {
  room: RoomBinding | undefined;
  animeId: number;
  episode: number;
  /** The stream the room asked for. */
  asked: StreamChoice;
  /** The stream that answered: another one when the asked one couldn't play. */
  playing: StreamChoice;
  /** The stream has answered (the player has a URL). */
  ready: boolean;
  /** The room lets the API choose, so any stream that answers is the room's. */
  automatic: boolean;
};

/**
 * When the room's stream can't play for the host and another one answered, moves the room to
 * the one that plays, so the host's pick never looks ignored and everyone ends up on the same
 * stream. Returns true while the room is being moved, so the player can skip the
 * "other source" notice for the host.
 */
export function useFollowFallback({ room, animeId, episode, asked, playing, ready, automatic }: Args): boolean {
  const key = `${animeId}-${episode}`;
  const fellBack = ready && !automatic && !sameStream(asked, playing);
  const follow = fellBack && room?.switchStream !== undefined && (follows.get(key) ?? 0) < MAX_FOLLOWS;
  const done = useRef(false);

  useEffect(() => {
    if (!follow || done.current || !room?.switchStream) return;
    done.current = true;
    follows.set(key, (follows.get(key) ?? 0) + 1);
    lastMove = { key, failed: asked, playing, at: Date.now() };
    void room.switchStream(playing);
    // Runs once per player: the room reloads it on the new stream.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [follow]);

  return follow;
}
