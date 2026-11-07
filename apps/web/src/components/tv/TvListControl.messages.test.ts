import { describe, expect, it } from "vitest";

import en from "../../../messages/en/title.json";
import pt from "../../../messages/pt/title.json";

describe("TvListControl messages", () => {
  it.each([
    ["en", en],
    ["pt", pt],
  ])("has every titlePage.list key in %s", (_, messages) => {
    const list = messages.titlePage.list as Record<string, unknown>;
    for (const key of ["label", "add", "remove", "status"]) expect(list[key]).toBeTruthy();
  });
});
