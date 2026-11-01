"use client";

import { useEffect } from "react";

export const SEEK_STEP = 10;
export const VOLUME_STEP = 0.1;

export type PlayerKeyActions = {
  togglePlay: () => void;
  seekBy: (delta: number) => void;
  changeVolume: (delta: number) => void;
  toggleFullscreen: () => void;
  toggleMute: () => void;
  goNext: () => void;
  skipNow: () => void;
  /** Called on Escape while the settings menu is open. */
  closeSettings: () => void;
  /** Called after any shortcut was handled, to show the controls. */
  poke: () => void;
};

/** The keyboard shortcuts of the player. */
export function usePlayerKeys(actions: PlayerKeyActions, settingsOpen: boolean) {
  const { togglePlay, seekBy, changeVolume, toggleFullscreen, toggleMute, goNext, skipNow, closeSettings, poke } =
    actions;
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target as HTMLElement;
      const tag = target.tagName;
      if (tag === "SELECT" || tag === "TEXTAREA" || (tag === "INPUT" && (target as HTMLInputElement).type !== "range")) {
        return;
      }
      const onButton = tag === "BUTTON" || tag === "A";
      switch (e.key) {
        case " ":
          // A focused button or link handles Space itself.
          if (onButton) return;
          togglePlay();
          break;
        case "k":
          togglePlay();
          break;
        case "ArrowLeft":
          seekBy(-SEEK_STEP);
          break;
        case "ArrowRight":
          seekBy(SEEK_STEP);
          break;
        case "ArrowUp":
          changeVolume(VOLUME_STEP);
          break;
        case "ArrowDown":
          changeVolume(-VOLUME_STEP);
          break;
        case "f":
          toggleFullscreen();
          break;
        case "m":
          toggleMute();
          break;
        case "n":
          goNext();
          break;
        case "s":
          skipNow();
          break;
        case "Escape":
          if (!settingsOpen) return;
          closeSettings();
          break;
        default:
          return;
      }
      e.preventDefault();
      poke();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePlay, seekBy, changeVolume, toggleFullscreen, toggleMute, goNext, skipNow, closeSettings, settingsOpen, poke]);
}
