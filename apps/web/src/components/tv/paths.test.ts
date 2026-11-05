import { describe, expect, it } from "vitest";

import { tvHref } from "./paths";

describe("tvHref", () => {
  it("puts a site address under /tv", () => {
    expect(tvHref("/anime/1")).toBe("/tv/anime/1");
    expect(tvHref("/")).toBe("/tv");
  });
});
