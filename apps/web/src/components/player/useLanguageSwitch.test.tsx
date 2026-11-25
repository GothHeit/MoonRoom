import { act, renderHook, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import player from "../../../messages/en/player.json";
import sources from "../../../messages/en/sources.json";

const post = vi.fn();
const get = vi.fn();
const put = vi.fn();
const patch = vi.fn();
vi.mock("@/lib/api", () => ({ api: { POST: post, GET: get, PATCH: patch, PUT: put } }));

const { useLanguageSwitch } = await import("./useLanguageSwitch");

const CHOICES = [
  { language: "pt", kind: "sub", state: "ready", source: "animesdigital", lang: "sub", resolution: 720 },
  { language: "pt", kind: "dub", state: "none" },
  { language: "en", kind: "sub", state: "ready", source: "zoko", lang: "sub", resolution: 1080 },
  { language: "en", kind: "dub", state: "ready", source: "zoko", lang: "dub", resolution: 1080 },
];

const messages = { player: { ...player.player, ...sources.player } };
const wrapper = ({ children }: { children: ReactNode }) => (
  <NextIntlClientProvider locale="en" messages={messages}>
    {children}
  </NextIntlClientProvider>
);

function setup(reload = vi.fn(), chooseAudio = vi.fn(), chooseSubtitle = vi.fn()) {
  const hook = renderHook(
    () =>
      useLanguageSwitch({
        animeId: 1,
        episode: 3,
        enabled: true,
        loaded: true,
        now: { audioTracks: [], audioTrack: -1, subtitles: [{ lang: "en" }], subtitle: 0, source: "zoko", lang: "sub" },
        heights: [],
        chooseAudio,
        chooseSubtitle,
        showSubtitle: vi.fn(),
        position: () => 42,
        reload,
        onPicked: vi.fn(),
      }),
    { wrapper },
  );
  return hook;
}

beforeEach(() => {
  post.mockReset();
  get.mockReset().mockResolvedValue({ data: CHOICES });
  put.mockReset().mockResolvedValue({});
  patch.mockReset().mockResolvedValue({});
});

describe("useLanguageSwitch", () => {
  it("shows each choice with what plays it, and what is on now", async () => {
    const { result } = setup();
    await waitFor(() => expect(result.current.offered).toBe(true));
    expect(result.current.label).toBe("English · Subtitled");
    const rows = result.current.rows();
    expect(rows.map((r) => [r.key, r.detail, r.disabled, r.checked])).toEqual([
      ["pt-sub", "720p · Animes Digital", false, false],
      ["pt-dub", "Not available for this episode", true, false],
      ["en-sub", "1080p · Zoko", false, true],
      ["en-dub", "1080p · Zoko", false, false],
    ]);
  });

  it("resolves the other stream first, then reloads onto it at the same moment", async () => {
    post.mockResolvedValue({ data: { source: "animesdigital", lang: "sub" } });
    const reload = vi.fn();
    const { result } = setup(reload);
    await waitFor(() => expect(result.current.offered).toBe(true));
    await act(async () => result.current.rows()[0].onPick());
    expect(post).toHaveBeenCalledWith("/watch/{source}/{anime_id}/episodes/{episode}/play", {
      params: { path: { source: "animesdigital", anime_id: 1, episode: 3 }, query: { lang: "sub", audio: "original" } },
    });
    expect(patch).toHaveBeenCalledWith("/me", { body: { subtitle_lang: "pt-BR" } });
    expect(reload).toHaveBeenCalledWith("/watch/animesdigital/1/3?t=42&audio=original&subs=pt-BR");
  });

  it("stays and says so when the other stream doesn't start, or another source answers", async () => {
    post.mockResolvedValue({ data: { source: "zoko", lang: "sub" } });
    const reload = vi.fn();
    const { result } = setup(reload);
    await waitFor(() => expect(result.current.offered).toBe(true));
    await act(async () => result.current.rows()[0].onPick());
    expect(reload).not.toHaveBeenCalled();
    expect(result.current.notice).toEqual({ text: "Portuguese · Subtitled didn’t start. You’re still on what you had.", busy: false });
  });
});
