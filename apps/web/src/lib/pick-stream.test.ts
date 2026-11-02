import { describe, expect, it, vi } from "vitest";

import { pickStream } from "./pick-stream";

const lists: Record<string, number[]> = {
  "auto-sub": [1, 2],
  "zoko-sub": [1, 2],
  "animesdigital-sub": [1, 2],
  "animesdigital-dub": [],
};
const episodesOf = vi.fn(async ({ source, lang }: { source: string; lang: string }) => {
  const episodes = lists[`${source}-${lang}`];
  if (!episodes) throw new Error("down");
  return { episodes };
});

describe("pickStream", () => {
  it("plays from the saved pick when it has episodes", async () => {
    const found = { sources: ["zoko", "animesdigital"], choice: { source: "animesdigital", lang: "sub" as const } };
    expect((await pickStream(found, episodesOf))?.choice).toEqual({ source: "animesdigital", lang: "sub" });
  });

  it("falls back to the automatic choice when the pick lists nothing or fails", async () => {
    for (const lang of ["dub", "sub"] as const) {
      const source = lang === "dub" ? "animesdigital" : "gone";
      const found = { sources: ["zoko", "animesdigital"], choice: { source, lang } };
      expect((await pickStream(found, episodesOf))?.choice).toEqual({ source: "auto", lang: "sub" });
    }
  });

  it("uses the automatic choice without a pick, and gives up when nothing has episodes", async () => {
    expect((await pickStream({ sources: ["zoko"], choice: null }, episodesOf))?.listed.episodes).toEqual([1, 2]);
    expect(await pickStream({ sources: [] }, episodesOf)).toBeNull();
    expect(await pickStream({ sources: ["gone"] }, async () => ({ episodes: [] }))).toBeNull();
    expect(await pickStream(undefined, episodesOf)).toBeNull();
  });
});
