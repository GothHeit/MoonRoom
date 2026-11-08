import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const refresh = vi.fn();
vi.mock("@/i18n/navigation", () => ({ useRouter: () => ({ refresh, replace: vi.fn() }) }));

const { TvPinGuard } = await import("./TvPinGuard");

const MINUTE = 60_000;

function locks(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter(([url]) => String(url).includes("/auth/pin/lock")).length;
}

describe("TvPinGuard", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("locks after 20 idle minutes with nothing playing", async () => {
    render(<TvPinGuard />);
    await act(() => vi.advanceTimersByTimeAsync(20 * MINUTE + 1000));
    expect(locks(fetchMock)).toBe(1);
  });

  it("doesn't lock when the next episode starts on its own between checks", async () => {
    const video = document.createElement("video");
    let paused = false;
    Object.defineProperty(video, "paused", { get: () => paused });
    document.body.appendChild(video);
    render(<TvPinGuard />);
    // Half an hour of an episode playing, nobody touching the remote.
    await act(() => vi.advanceTimersByTimeAsync(30 * MINUTE));
    expect(locks(fetchMock)).toBe(0);
    // It ends, and the next one starts a few seconds later.
    paused = true;
    await act(() => vi.advanceTimersByTimeAsync(5000));
    paused = false;
    act(() => void video.dispatchEvent(new Event("playing")));
    await act(() => vi.advanceTimersByTimeAsync(2 * MINUTE));
    expect(locks(fetchMock)).toBe(0);
  });
});
