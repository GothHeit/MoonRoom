import { renderHook } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { SEEK_STEP, usePlayerKeys, VOLUME_STEP, type PlayerKeyActions } from "./usePlayerKeys";

function setup(settingsOpen = false) {
  const actions: PlayerKeyActions = {
    togglePlay: vi.fn(),
    seekBy: vi.fn(),
    changeVolume: vi.fn(),
    toggleFullscreen: vi.fn(),
    toggleMute: vi.fn(),
    goNext: vi.fn(),
    skipNow: vi.fn(),
    closeSettings: vi.fn(),
    poke: vi.fn(),
  };
  const view = renderHook(() => usePlayerKeys(actions, settingsOpen));
  return { actions, ...view };
}

describe("usePlayerKeys", () => {
  it("maps the shortcuts to their actions and shows the controls", async () => {
    const { actions } = setup();
    const user = userEvent.setup();
    await user.keyboard("k");
    await user.keyboard("{ArrowLeft}");
    await user.keyboard("{ArrowRight}");
    await user.keyboard("{ArrowUp}");
    await user.keyboard("{ArrowDown}");
    await user.keyboard("f");
    await user.keyboard("m");
    await user.keyboard("n");
    await user.keyboard("s");
    expect(actions.togglePlay).toHaveBeenCalledTimes(1);
    expect(actions.seekBy).toHaveBeenNthCalledWith(1, -SEEK_STEP);
    expect(actions.seekBy).toHaveBeenNthCalledWith(2, SEEK_STEP);
    expect(actions.changeVolume).toHaveBeenNthCalledWith(1, VOLUME_STEP);
    expect(actions.changeVolume).toHaveBeenNthCalledWith(2, -VOLUME_STEP);
    expect(actions.toggleFullscreen).toHaveBeenCalledTimes(1);
    expect(actions.toggleMute).toHaveBeenCalledTimes(1);
    expect(actions.goNext).toHaveBeenCalledTimes(1);
    expect(actions.skipNow).toHaveBeenCalledTimes(1);
    expect(actions.poke).toHaveBeenCalledTimes(9);
  });

  it("toggles play on Space unless a button has focus", async () => {
    const { actions } = setup();
    const user = userEvent.setup();
    await user.keyboard(" ");
    expect(actions.togglePlay).toHaveBeenCalledTimes(1);

    const button = document.body.appendChild(document.createElement("button"));
    button.focus();
    await user.keyboard(" ");
    expect(actions.togglePlay).toHaveBeenCalledTimes(1);
    button.remove();
  });

  it("ignores keys typed into text fields and combined with a modifier", async () => {
    const { actions } = setup();
    const user = userEvent.setup();
    const input = document.body.appendChild(document.createElement("input"));
    input.focus();
    await user.keyboard("kfm");
    input.remove();
    await user.keyboard("{Control>}k{/Control}");
    expect(actions.togglePlay).not.toHaveBeenCalled();
    expect(actions.toggleFullscreen).not.toHaveBeenCalled();
    expect(actions.poke).not.toHaveBeenCalled();
  });

  it("still handles keys on a range slider", async () => {
    const { actions } = setup();
    const user = userEvent.setup();
    const slider = document.body.appendChild(document.createElement("input"));
    slider.type = "range";
    slider.focus();
    await user.keyboard("m");
    slider.remove();
    expect(actions.toggleMute).toHaveBeenCalledTimes(1);
  });

  it("closes the settings on Escape only while they are open", async () => {
    const closed = setup(false);
    const user = userEvent.setup();
    await user.keyboard("{Escape}");
    expect(closed.actions.closeSettings).not.toHaveBeenCalled();
    closed.unmount();

    const open = setup(true);
    await user.keyboard("{Escape}");
    expect(open.actions.closeSettings).toHaveBeenCalledTimes(1);
  });
});
