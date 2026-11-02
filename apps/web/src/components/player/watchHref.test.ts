import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", () => ({ api: {} }));

const { pickAudio, uniqueAudio } = await import("./useHls");
const { pickTrack } = await import("./useSubtitles");

describe("pickTrack", () => {
  const tracks = [
    { lang: "en", label: "English", url: "a" },
    { lang: "pt-BR", label: "Portuguese", url: "b" },
    { lang: "es", label: "Spanish", url: "c" },
  ];

  it("defaults to pt-BR, then English", () => {
    expect(pickTrack(tracks, null)).toBe(1);
    expect(pickTrack([tracks[0], tracks[2]], null)).toBe(0);
    expect(pickTrack([tracks[2]], null)).toBe(-1);
  });

  it("honours a saved language, falling back when the episode lacks it", () => {
    expect(pickTrack(tracks, "es")).toBe(2);
    expect(pickTrack(tracks, "fr")).toBe(1);
  });

  it("turns subtitles off", () => {
    expect(pickTrack(tracks, "off")).toBe(-1);
  });

  it("prefers Portugal's Portuguese over English when there is no pt-BR", () => {
    expect(pickTrack([tracks[0], { lang: "pt", label: "Portuguese (Portugal)", url: "d" }], null)).toBe(1);
  });
});

describe("pickAudio", () => {
  const audio = [
    { id: 0, name: "English", lang: "en" },
    { id: 1, name: "Japanese", lang: "ja" },
  ];

  it("matches the source's default by name or language, else takes the first", () => {
    expect(pickAudio(audio, "japanese")).toBe(1);
    expect(pickAudio(audio, "ja")).toBe(1);
    expect(pickAudio(audio, "fr")).toBe(0);
    expect(pickAudio(audio, null)).toBe(0);
    expect(pickAudio([], "ja")).toBe(-1);
  });

  it("takes the track the stream marks as default over the first one", () => {
    const listed = [
      { id: 0, name: "Hindi", lang: "hin" },
      { id: 1, name: "Japanese", lang: "jpn", default: true },
    ];
    expect(pickAudio(listed, null)).toBe(1);
    expect(pickAudio(listed, "fr")).toBe(1);
    // A wanted dub still wins over the default.
    expect(pickAudio(listed, "hin")).toBe(0);
  });
});

describe("uniqueAudio", () => {
  it("lists a track once even when the master repeats it for every quality", () => {
    const repeated = [
      { id: 0, name: "Japanese", lang: "jpn" },
      { id: 1, name: "Portuguese", lang: "por" },
      { id: 2, name: "Japanese", lang: "jpn" },
      { id: 3, name: "Portuguese", lang: "por" },
      { id: 4, name: "Portuguese", lang: "pt-BR" },
    ];
    expect(uniqueAudio(repeated).map((a) => a.id)).toEqual([0, 1, 4]);
  });
});
