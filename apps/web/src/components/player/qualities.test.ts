import { describe, expect, it } from "vitest";

import { capLevel, levelsToDrop, qualityList } from "./qualities";

describe("qualityList", () => {
  it("lists each height once, tallest first, and skips unknown heights", () => {
    expect(qualityList([{ height: 720 }, { height: 1080 }, { height: 0 }, { height: 1080 }])).toEqual([
      { index: 1, height: 1080 },
      { index: 0, height: 720 },
    ]);
  });
});

describe("levelsToDrop", () => {
  it("drops the H.264 copy when an HEVC level is playable", () => {
    expect(levelsToDrop([{ videoCodec: "avc1.640028" }, { videoCodec: "hvc1.2.4.L120.B0" }])).toEqual([0]);
  });

  it("drops nothing when no HEVC level is left", () => {
    expect(levelsToDrop([{ videoCodec: "avc1.640028" }, { videoCodec: undefined }])).toEqual([]);
  });
});

describe("capLevel", () => {
  const levels = [{ height: 360 }, { height: 1080 }, { height: 720 }];

  it("takes the tallest level within the limit", () => {
    expect(capLevel(levels, 720)).toBe(2);
    expect(capLevel(levels, 1080)).toBe(1);
    expect(capLevel(levels, 500)).toBe(0);
  });

  it("takes the smallest level when everything is taller than the limit", () => {
    expect(capLevel([{ height: 1080 }, { height: 720 }], 480)).toBe(1);
  });

  it("does not cap without a limit", () => {
    expect(capLevel(levels, null)).toBe(-1);
    expect(capLevel([], 720)).toBe(-1);
  });
});
