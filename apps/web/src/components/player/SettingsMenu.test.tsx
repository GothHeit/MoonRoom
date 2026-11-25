import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";

import messages from "../../../messages/en/player.json";
import { SettingsMenu, type LanguageRow } from "./SettingsMenu";
import { DEFAULT_STYLE } from "./subtitleStyle";

function setup(streams: string[], languages: LanguageRow[] | null = null, initialView?: "main" | "language") {
  const onStream = vi.fn();
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <SettingsMenu
        languages={languages}
        languageName="Portuguese · Subtitled"
        initialView={initialView}
        qualities={[]}
        quality={-1}
        onQuality={vi.fn()}
        audioTracks={[]}
        audioTrack={-1}
        onAudioTrack={vi.fn()}
        streams={streams}
        stream={0}
        onStream={onStream}
        streamName={streams[0] ?? "Zoko · Subtitled"}
        subtitleNames={[]}
        subtitle={-1}
        onSubtitle={vi.fn()}
        speeds={[1]}
        rate={1}
        onRate={vi.fn()}
        style={DEFAULT_STYLE}
        onStyle={vi.fn()}
        onClose={vi.fn()}
      />
    </NextIntlClientProvider>,
  );
  return onStream;
}

describe("SettingsMenu source", () => {
  it("lists the sources and picks one", async () => {
    const onStream = setup(["Zoko · Subtitled", "Animes Digital · Portuguese subtitles"]);
    await userEvent.click(screen.getByRole("button", { name: /Source/ }));
    expect(screen.getByRole("radio", { name: /Zoko/ })).toHaveAttribute("aria-checked", "true");
    await userEvent.click(screen.getByRole("radio", { name: /Animes Digital/ }));
    expect(onStream).toHaveBeenCalledWith(1);
  });

  it("is hidden when there is nothing to switch to", () => {
    setup(["Zoko · Subtitled"]);
    expect(screen.queryByRole("button", { name: /Source/ })).not.toBeInTheDocument();
  });
});

describe("SettingsMenu keys", () => {
  it("steps back to the main list on Escape in a sub-view, without letting the key through", async () => {
    setup([]);
    const outside = vi.fn();
    window.addEventListener("keydown", outside);
    await userEvent.click(screen.getByRole("button", { name: /Playback speed/ }));
    screen.getByRole("button", { name: "Back" }).focus();
    await userEvent.keyboard("{Escape}");
    expect(screen.getByRole("button", { name: /Playback speed/ })).toBeInTheDocument();
    expect(outside).not.toHaveBeenCalled();
    window.removeEventListener("keydown", outside);
  });
});

function row(overrides: Partial<LanguageRow>): LanguageRow {
  return {
    key: "pt-sub",
    section: "Portuguese",
    label: "Subtitled",
    detail: "1080p · AniZone",
    checked: false,
    disabled: false,
    checking: false,
    onPick: vi.fn(),
    ...overrides,
  };
}

describe("SettingsMenu language", () => {
  it("lists the choices under their language and picks one", async () => {
    const enSub = row({ key: "en-sub", section: "English", detail: "1080p · Zoko" });
    setup([], [row({ checked: true }), row({ key: "pt-dub", label: "Dubbed", detail: "Not available", disabled: true }), enSub]);
    await userEvent.click(screen.getByRole("button", { name: /Language/ }));

    expect(screen.getByRole("radiogroup", { name: "Portuguese" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Dubbed/ })).toBeDisabled();
    await userEvent.click(screen.getByRole("radio", { name: /1080p · Zoko/ }));
    expect(enSub.onPick).toHaveBeenCalled();
  });

  it("opens straight on the language list from the player's language button", () => {
    setup(["Zoko · Subtitled", "AniZone · Subtitled, all dubs"], [row({})], "language");
    expect(screen.getByRole("radiogroup", { name: "Portuguese" })).toBeInTheDocument();
    // The source list stays one step away.
    expect(screen.getByRole("button", { name: /Source/ })).toBeInTheDocument();
  });

  it("is not offered without choices", () => {
    setup([], null);
    expect(screen.queryByRole("button", { name: /Language/ })).not.toBeInTheDocument();
  });
});
