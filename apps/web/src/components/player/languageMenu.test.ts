import { describe, expect, it } from "vitest";

import { baseLang, instantMove, playingChoice, startWith, type LanguageChoice, type NowPlaying } from "./languageMenu";

const choices: LanguageChoice[] = [
  { language: "pt", kind: "sub", state: "ready", source: "digital", lang: "sub", resolution: 720 },
  { language: "pt", kind: "dub", state: "ready", source: "zone", lang: "sub", resolution: 1080 },
  { language: "en", kind: "sub", state: "ready", source: "zoko", lang: "sub", resolution: 1080 },
  { language: "en", kind: "dub", state: "none" },
];

function now(overrides: Partial<NowPlaying>): NowPlaying {
  return { audioTracks: [], audioTrack: -1, subtitles: [], subtitle: -1, source: "zoko", lang: "sub", ...overrides };
}

const zone = now({
  source: "zone",
  audioTracks: [
    { id: 0, lang: "jpn" },
    { id: 1, lang: "por" },
  ],
  audioTrack: 0,
  subtitles: [{ lang: "pt-BR" }, { lang: "en" }],
  subtitle: 0,
});

describe("language menu", () => {
  it("reads base languages", () => {
    expect([baseLang("pt-BR"), baseLang("por"), baseLang("ENG"), baseLang(undefined)]).toEqual(["pt", "pt", "en", ""]);
  });

  it("knows what is playing from the tracks that are on", () => {
    expect(playingChoice(choices, zone)).toEqual({ language: "pt", kind: "sub" });
    expect(playingChoice(choices, { ...zone, audioTrack: 1 })).toEqual({ language: "pt", kind: "dub" });
    // Burned-in Portuguese: the stream itself says it.
    expect(playingChoice(choices, now({ source: "digital" }))).toEqual({ language: "pt", kind: "sub" });
    expect(playingChoice(choices, now({ source: "other" }))).toBeNull();
  });

  it("switches inside the stream when it carries the language", () => {
    expect(instantMove(choices[1], zone)).toEqual({ audio: 1, subtitle: -1 });
    expect(instantMove(choices[2], zone)).toEqual({ audio: 0, subtitle: 1 });
    expect(instantMove(choices[2], { ...zone, audioTrack: 1 })).toEqual({ audio: 0, subtitle: 1 });
  });

  it("needs another stream when the loaded one lacks the language", () => {
    expect(instantMove(choices[2], now({ source: "digital" }))).toBeNull();
    expect(instantMove(choices[1], now({ subtitles: [{ lang: "pt-BR" }] }))).toBeNull();
    // Subtitled needs the original audio.
    expect(instantMove(choices[0], now({ lang: "dub", subtitles: [{ lang: "pt-BR" }] }))).toBeNull();
  });

  it("starts a reloaded choice on its audio and subtitles", () => {
    expect(startWith(choices[0])).toEqual({ audio: "original", subs: "pt-BR" });
    expect(startWith(choices[1])).toEqual({ audio: "pt", subs: "off" });
  });
});
