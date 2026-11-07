import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const instances: FakeJassub[] = [];

class FakeJassub {
  opts: Record<string, unknown>;
  _worker = Object.assign(new EventTarget(), { terminate: vi.fn() });
  ready = Promise.resolve();
  busy = false;
  constructor(opts: Record<string, unknown>) {
    this.opts = opts;
    instances.push(this);
  }
  manualRender = vi.fn(async () => undefined);
  destroy = vi.fn(async () => undefined);
}

vi.mock("jassub", () => ({ default: FakeJassub }));

const { AssSubtitles, TV_LIBASS_LIMITS } = await import("./AssSubtitles");

function setup(lowMemory = false) {
  const el = document.createElement("video");
  Object.defineProperty(el, "paused", { value: false, configurable: true });
  const video = { current: el };
  const onFail = vi.fn();
  render(<AssSubtitles video={video} url="/subs.ass" fonts={{}} onFail={onFail} lowMemory={lowMemory} />);
  return { onFail };
}

async function started() {
  await waitFor(() => expect(instances.length).toBe(1));
  const r = instances[0];
  await act(async () => {
    await r.ready;
  });
  return r;
}

beforeEach(() => {
  instances.length = 0;
  vi.stubGlobal("fetch", vi.fn(async () => new Response("[Script Info]")));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("AssSubtitles", () => {
  it("caps libass's caches only on a device short on memory", async () => {
    setup(true);
    expect((await started()).opts).toMatchObject(TV_LIBASS_LIMITS);
    instances.length = 0;
    setup(false);
    await waitFor(() => expect(instances.length).toBe(1));
    expect(instances[0].opts.libassMemoryLimit).toBeUndefined();
  });

  it("falls back to the plain copy when the worker dies mid-episode", async () => {
    const { onFail } = setup(true);
    const r = await started();
    act(() => void r._worker.dispatchEvent(new Event("error")));
    expect(onFail).toHaveBeenCalledTimes(1);
    expect(r._worker.terminate).toHaveBeenCalled();
    // Only once, however many errors follow.
    act(() => void r._worker.dispatchEvent(new Event("error")));
    expect(onFail).toHaveBeenCalledTimes(1);
  });

  it("falls back when a draw never finishes while the video plays", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { onFail } = setup(true);
    const r = await started();
    r.busy = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    // A slow draw or two is fine.
    expect(onFail).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    expect(onFail).toHaveBeenCalledTimes(1);
  });
});
