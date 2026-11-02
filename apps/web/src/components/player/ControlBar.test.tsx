import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";

import messages from "../../../messages/en/player.json";
import { ControlBar } from "./ControlBar";

function setup(duration: number) {
  const noop = vi.fn();
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <ControlBar
        current={0}
        duration={duration}
        playing={false}
        muted={false}
        volume={1}
        fullscreen={false}
        settingsOpen={false}
        hasNext={false}
        onSeekTo={noop}
        onTogglePlay={noop}
        onSeekBy={noop}
        onToggleMute={noop}
        onVolume={noop}
        onToggleSettings={noop}
        onNext={noop}
        onToggleFullscreen={noop}
      />
    </NextIntlClientProvider>,
  );
}

describe("ControlBar", () => {
  it("hides the time and seek bar until the length is known", () => {
    setup(0);
    expect(screen.queryByRole("slider", { name: messages.player.seek })).toBeNull();
    expect(screen.getByRole("button", { name: messages.player.play })).toBeTruthy();
  });

  it("shows them once the stream says how long it is", () => {
    setup(1420);
    expect(screen.getByRole("slider", { name: messages.player.seek })).toBeTruthy();
    expect(screen.getByText("23:40")).toBeTruthy();
  });
});
