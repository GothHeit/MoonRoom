import { act, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import intl from "../../../messages/en/room.json";
import { RoomOverlay } from "./RoomOverlay";
import type { Playback } from "./sync";

function show(playback: Playback, extra: Partial<Parameters<typeof RoomOverlay>[0]> = {}) {
  render(
    <NextIntlClientProvider locale="en" messages={intl}>
      <RoomOverlay
        playback={playback}
        serverNow={() => Date.now()}
        toasts={[]}
        reactions={[]}
        reconnecting={false}
        waitingFor={[]}
        {...extra}
      />
    </NextIntlClientProvider>,
  );
}

describe("RoomOverlay", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("counts down to a scheduled episode start, then gets out of the way", () => {
    show({ playing: true, position: 0, at: Date.now() + 3000, version: 4 });
    act(() => void vi.advanceTimersByTime(150));
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("Starting for everyone")).toBeInTheDocument();
    act(() => void vi.advanceTimersByTime(1000));
    expect(screen.getByText("2")).toBeInTheDocument();
    act(() => void vi.advanceTimersByTime(2000));
    expect(screen.queryByText("Starting for everyone")).not.toBeInTheDocument();
  });

  it("doesn't count down the short lead of a play or a seek", () => {
    show({ playing: true, position: 30, at: Date.now() + 400, version: 5 });
    act(() => void vi.advanceTimersByTime(150));
    expect(screen.queryByText("Starting for everyone")).not.toBeInTheDocument();
  });

  it("says when it is reconnecting, who it waits for, and shows new messages", () => {
    show(
      { playing: false, position: 0, at: Date.now(), version: 1 },
      {
        reconnecting: true,
        waitingFor: ["bob"],
        toasts: [{ id: "m", user_id: "b", username: "bob", text: "brb", reaction: false }],
      },
    );
    expect(screen.getByText("Reconnecting to the room…")).toBeInTheDocument();
    expect(screen.getByText("Waiting for bob…")).toBeInTheDocument();
    expect(screen.getByText("brb")).toBeInTheDocument();
  });
});
