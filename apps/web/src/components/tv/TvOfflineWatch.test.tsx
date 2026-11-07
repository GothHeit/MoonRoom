import { act, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import messages from "../../../messages/en/tv.json";
import { TvOfflineWatch } from "./TvOfflineWatch";

function show() {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <TvOfflineWatch />
    </NextIntlClientProvider>,
  );
}

describe("TvOfflineWatch", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("shows nothing while the site answers", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    show();
    await act(() => vi.advanceTimersByTimeAsync(20_000));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("covers the screen once the site stops answering, then the long text after a minute", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    show();
    await act(() => vi.advanceTimersByTimeAsync(9_000));
    expect(screen.getByRole("status").textContent).toContain("Reconnecting");
    await act(() => vi.advanceTimersByTimeAsync(70_000));
    expect(screen.getByRole("status").textContent).toContain(
      "MoonRoom is offline",
    );
  });

  it("does not cover the screen when a slow check finally succeeds, and never overlaps checks", async () => {
    let resolveFirst: (value: { ok: boolean }) => void = () => {};
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(
        () => new Promise((resolve) => (resolveFirst = resolve)),
      )
      .mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    show();
    await act(() => vi.advanceTimersByTimeAsync(20_000));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => resolveFirst({ ok: true }));
    await act(() => vi.advanceTimersByTimeAsync(20_000));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("leaves a playing episode alone, then covers it and lets go of it once it stops", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    const video = document.createElement("video");
    let paused = false;
    Object.defineProperty(video, "paused", { get: () => paused });
    Object.defineProperty(video, "readyState", { get: () => (paused ? 1 : 4) });
    const pause = vi.spyOn(video, "pause").mockImplementation(() => {});
    const load = vi.spyOn(video, "load").mockImplementation(() => {});
    video.src = "blob:stream";
    document.body.appendChild(video);
    try {
      show();
      await act(() => vi.advanceTimersByTimeAsync(30_000));
      expect(screen.queryByRole("status")).toBeNull();
      expect(pause).not.toHaveBeenCalled();
      paused = true;
      await act(() => vi.advanceTimersByTimeAsync(5_000));
      expect(screen.getByRole("status")).toBeTruthy();
      expect(video.hasAttribute("src")).toBe(false);
      expect(load).toHaveBeenCalled();
    } finally {
      video.remove();
    }
  });

  it("gives up on a check that hangs and counts it as a miss", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_, reject) =>
            init.signal?.addEventListener("abort", () =>
              reject(new Error("abort")),
            ),
          ),
      ),
    );
    show();
    await act(() => vi.advanceTimersByTimeAsync(40_000));
    expect(screen.getByRole("status")).toBeTruthy();
  });
});
