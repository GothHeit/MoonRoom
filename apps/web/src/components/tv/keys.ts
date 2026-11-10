// What a remote's keys mean in the TV mode. Each platform sends its own codes: Tizen (Samsung)
// and webOS (LG) send key codes for the media keys and Back, a browser sends named keys.

// Back: Tizen 10009, webOS 461.
const BACK_CODES = [10009, 461];

/** The media keys the player listens to, by Tizen/webOS key code. */
const MEDIA_CODES: Record<number, MediaKey> = {
  10252: "playPause",
  415: "play",
  19: "pause",
  413: "stop",
  417: "forward",
  412: "rewind",
};

const MEDIA_NAMES: Record<string, MediaKey> = {
  MediaPlayPause: "playPause",
  MediaPlay: "play",
  MediaPause: "pause",
  MediaStop: "stop",
  MediaFastForward: "forward",
  MediaRewind: "rewind",
  MediaTrackNext: "next",
};

export type MediaKey = "playPause" | "play" | "pause" | "stop" | "forward" | "rewind" | "next";

/**
 * The key names a Tizen app has to ask for before it gets them: without this the TV keeps the
 * media keys for itself. Back and the arrows come without asking.
 */
export const TIZEN_MEDIA_KEYS = ["MediaPlayPause", "MediaPlay", "MediaPause", "MediaStop", "MediaFastForward", "MediaRewind"];

function isTyping(target: EventTarget | null) {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
}

export function isBack(event: KeyboardEvent) {
  return (
    BACK_CODES.includes(event.keyCode) ||
    event.key === "Escape" ||
    event.key === "GoBack" ||
    event.key === "BrowserBack" ||
    (event.key === "Backspace" && !isTyping(event.target))
  );
}

export function mediaKey(event: KeyboardEvent): MediaKey | null {
  return MEDIA_NAMES[event.key] ?? MEDIA_CODES[event.keyCode] ?? null;
}

type TizenWindow = Window & {
  tizen?: { tvinputdevice?: { registerKeyBatch?: (keys: string[]) => void; registerKey?: (key: string) => void } };
};

/** Asks a Samsung TV for its media keys. Does nothing outside a Tizen app. */
export function registerMediaKeys() {
  const input = (window as TizenWindow).tizen?.tvinputdevice;
  if (!input) return;
  try {
    if (input.registerKeyBatch) input.registerKeyBatch(TIZEN_MEDIA_KEYS);
    else TIZEN_MEDIA_KEYS.forEach((key) => input.registerKey?.(key));
  } catch {
    // An older TV without some of the keys: the remote's OK and arrows still work.
  }
}
