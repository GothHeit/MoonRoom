import { beforeEach, describe, expect, it, vi } from "vitest";

const post = vi.fn();
vi.mock("@/lib/api", () => ({ api: { POST: post } }));

const { warmPlayback } = await import("./warm-playback");

beforeEach(() => post.mockReset().mockResolvedValue({}));

describe("warmPlayback", () => {
  it("asks the API to prepare an episode once per visit", () => {
    warmPlayback("zoko", 21, 4, "dub");
    warmPlayback("zoko", 21, 4, "dub");
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith("/watch/{source}/{anime_id}/episodes/{episode}/prepare", {
      params: { path: { source: "zoko", anime_id: 21, episode: 4 }, query: { lang: "dub" } },
    });
    warmPlayback("zoko", 21, 5, "dub");
    expect(post).toHaveBeenCalledTimes(2);
  });
});
