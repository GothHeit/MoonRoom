/** Where the room is: at `position` at server time `at`, moving on in real time while it plays. */
export type Playback = {
  playing: boolean;
  /** Seconds into the episode at server time `at`. */
  position: number;
  /** Server time (epoch ms) that `position` is for. Ahead of now while a start is scheduled. */
  at: number;
  /** Goes up with every change; anything older than what a viewer has is stale. */
  version: number;
};

/** A local seek further than this from the room is the viewer's own; closer is the player settling. */
const SEEK_INTENT_SECONDS = 1;
/** How long after applying the room's state the player's own events are not the viewer's doing. */
export const APPLY_WINDOW_MS = 800;
/** Further apart than this and the player jumps to the room; closer, it catches up by speed. */
export const HARD_SEEK_SECONDS = 0.5;
/** AirPlay can't change speed and its seeks land late, so it only jumps, and only further out. */
const WIRELESS_SEEK_SECONDS = 1;
/** A nudge starts past this drift and stops under the second number, so it doesn't flicker. */
const NUDGE_START_SECONDS = 0.025;
const NUDGE_STOP_SECONDS = 0.005;
/** At most this much faster or slower: about 3 s per minute, unnoticeable with pitch kept. */
export const MAX_NUDGE = 0.06;
/** Speed change per second of drift, so half a second is made up in about 10 s... */
const NUDGE_GAIN = 0.5;
/** ...but never less than this, so the last few frames close in seconds, not a minute. */
const MIN_NUDGE = 0.01;
/** After a jump the player gets this long to settle before it may jump again. */
const SEEK_COOLDOWN_MS = 1500;
/** Paused players match the room to within about a frame. */
const PAUSED_TOLERANCE = 0.05;

export function expectedPosition(playback: Playback, serverNow: number): number {
  return playback.playing ? playback.position + Math.max(serverNow - playback.at, 0) / 1000 : playback.position;
}

/** The newer of two playbacks: older news (a late reply, a replayed event) never wins. */
export function newer(current: Playback, next: Playback): Playback {
  return next.version > current.version ? next : current;
}

export type LocalEvent = "play" | "pause" | "seek";

/**
 * What the viewer's own action means for the room: the action to send, or null when the room
 * already agrees (joining a playing room and pressing play must not rewind everyone).
 */
export function commandFor(
  event: LocalEvent,
  playback: Playback,
  currentTime: number,
  serverNow: number,
): { action: LocalEvent; position: number } | null {
  if (event === "play") return playback.playing ? null : { action: "play", position: currentTime };
  if (event === "pause") return playback.playing ? { action: "pause", position: currentTime } : null;
  const far = Math.abs(currentTime - expectedPosition(playback, serverNow)) > SEEK_INTENT_SECONDS;
  return far ? { action: "seek", position: currentTime } : null;
}

export type VideoState = {
  currentTime: number;
  paused: boolean;
  playbackRate: number;
  seeking: boolean;
  /** Playing on an AirPlay receiver. */
  wireless: boolean;
};

export type Fix = {
  seekTo: number | null;
  play: boolean | null;
  rate: number | null;
  /** A scheduled start: play in this many ms, already at the right spot. */
  startIn: number | null;
};

export type Timing = {
  /** Local `Date.now()`, for the seek cooldown. */
  now: number;
  lastSeekAt: number;
  /** How long this player's jumps take to land, in seconds, so a jump aims that far ahead. */
  seekCost: number;
};

/** Slower when ahead, faster when behind, by an amount that grows with the drift. */
const nudgeFor = (drift: number) => 1 - Math.sign(drift) * Math.min(MAX_NUDGE, Math.max(MIN_NUDGE, Math.abs(drift) * NUDGE_GAIN));

/**
 * What to do to a player so it matches the room, or null when it already does. Small drift is
 * made up by playing a little faster or slower; only a large one jumps.
 */
export function correction(playback: Playback, video: VideoState, serverNow: number, timing: Timing): Fix | null {
  if (video.seeking) return null;
  const fix: Fix = { seekTo: null, play: null, rate: null, startIn: null };
  const normal = () => {
    if (video.playbackRate !== 1) fix.rate = 1;
  };

  if (!playback.playing || serverNow < playback.at) {
    // Paused, or waiting for a scheduled start: hold at the room's spot.
    if (Math.abs(video.currentTime - playback.position) > PAUSED_TOLERANCE) fix.seekTo = playback.position;
    if (!video.paused) fix.play = false;
    if (playback.playing) fix.startIn = playback.at - serverNow;
    normal();
  } else {
    const target = expectedPosition(playback, serverNow);
    const drift = video.currentTime - target;
    const hard = video.wireless ? WIRELESS_SEEK_SECONDS : HARD_SEEK_SECONDS;
    const settled = timing.now - timing.lastSeekAt > SEEK_COOLDOWN_MS;
    if (video.paused) {
      if (Math.abs(drift) > PAUSED_TOLERANCE) fix.seekTo = target + timing.seekCost;
      fix.play = true;
      normal();
    } else if (Math.abs(drift) > hard) {
      if (settled) {
        fix.seekTo = target + timing.seekCost;
        normal();
      }
    } else if (video.wireless) {
      normal();
    } else {
      const nudging = video.playbackRate !== 1;
      if (Math.abs(drift) > NUDGE_START_SECONDS || (nudging && Math.abs(drift) > NUDGE_STOP_SECONDS)) {
        const rate = nudgeFor(drift);
        if (Math.abs(rate - video.playbackRate) > 0.004) fix.rate = Math.round(rate * 1000) / 1000;
      } else normal();
    }
  }
  return fix.seekTo === null && fix.play === null && fix.rate === null && fix.startIn === null ? null : fix;
}

/** Votes needed to switch episodes: more than half of the people in the room. */
export function votesNeeded(members: number): number {
  return Math.floor(members / 2) + 1;
}
