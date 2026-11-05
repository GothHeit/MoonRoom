import { describe, expect, it, vi } from "vitest";

import { isBack, mediaKey, registerMediaKeys, TIZEN_MEDIA_KEYS } from "./keys";

const key = (init: KeyboardEventInit & { keyCode?: number }) => {
  const event = new KeyboardEvent("keydown", init);
  if (init.keyCode !== undefined) Object.defineProperty(event, "keyCode", { value: init.keyCode });
  return event;
};

describe("remote keys", () => {
  it("reads Back from Samsung, LG and a browser", () => {
    expect(isBack(key({ keyCode: 10009 }))).toBe(true);
    expect(isBack(key({ keyCode: 461 }))).toBe(true);
    expect(isBack(key({ key: "Escape" }))).toBe(true);
    expect(isBack(key({ key: "Enter" }))).toBe(false);
  });

  it("reads the media keys by name and by TV key code", () => {
    expect(mediaKey(key({ key: "MediaPlayPause" }))).toBe("playPause");
    expect(mediaKey(key({ keyCode: 10252 }))).toBe("playPause");
    expect(mediaKey(key({ keyCode: 415 }))).toBe("play");
    expect(mediaKey(key({ keyCode: 19 }))).toBe("pause");
    expect(mediaKey(key({ keyCode: 417 }))).toBe("forward");
    expect(mediaKey(key({ keyCode: 412 }))).toBe("rewind");
    expect(mediaKey(key({ keyCode: 413 }))).toBe("stop");
    expect(mediaKey(key({ key: "ArrowLeft", keyCode: 37 }))).toBeNull();
  });

  it("asks a Samsung TV for its media keys, and does nothing elsewhere", () => {
    expect(() => registerMediaKeys()).not.toThrow();
    const registerKeyBatch = vi.fn();
    (window as unknown as { tizen: unknown }).tizen = { tvinputdevice: { registerKeyBatch } };
    registerMediaKeys();
    expect(registerKeyBatch).toHaveBeenCalledWith(TIZEN_MEDIA_KEYS);
    delete (window as unknown as { tizen?: unknown }).tizen;
  });
});
