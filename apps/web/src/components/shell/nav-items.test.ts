import { describe, expect, it } from "vitest";

import { counterpartOf, isActive, modeOf, navItemsFor, searchHrefFor } from "./nav-items";

describe("isActive", () => {
  it("matches home only exactly", () => {
    expect(isActive("/", "/")).toBe(true);
    expect(isActive("/browse", "/")).toBe(false);
  });
  it("matches a section and its children", () => {
    expect(isActive("/browse", "/browse")).toBe(true);
    expect(isActive("/browse/x", "/browse")).toBe(true);
    expect(isActive("/browser", "/browse")).toBe(false);
  });
  it("counts the reader as manga home, not browse", () => {
    expect(isActive("/read/mangadex/1/c1", "/manga")).toBe(true);
    expect(isActive("/manga/browse", "/manga")).toBe(false);
    expect(isActive("/manga/browse", "/manga/browse")).toBe(true);
  });
});

describe("modeOf", () => {
  it("reads the catalog from the address", () => {
    expect(modeOf("/")).toBe("anime");
    expect(modeOf("/anime/1")).toBe("anime");
    expect(modeOf("/manga")).toBe("manga");
    expect(modeOf("/manga/1")).toBe("manga");
    expect(modeOf("/read/mangadex/1/c1")).toBe("manga");
    expect(modeOf("/mangaka")).toBe("anime");
  });
  it("gives each mode its own home, browse and search", () => {
    expect(navItemsFor("manga").map((i) => i.href)).toEqual(["/manga", "/manga/browse", "/manga/list"]);
    expect(navItemsFor("anime").map((i) => i.href)).toEqual(["/", "/browse", "/list"]);
    expect(searchHrefFor("manga")).toBe("/manga/search");
  });
});

describe("counterpartOf", () => {
  it("keeps the user on the same page when the other catalog has it", () => {
    expect(counterpartOf("/list", "manga")).toBe("/manga/list");
    expect(counterpartOf("/manga/list", "anime")).toBe("/list");
    expect(counterpartOf("/manga/browse", "anime")).toBe("/browse");
    expect(counterpartOf("/search", "manga")).toBe("/manga/search");
    expect(counterpartOf("/", "manga")).toBe("/manga");
    expect(counterpartOf("/manga", "anime")).toBe("/");
  });
  it("stays put when asked for the catalog already shown", () => {
    expect(counterpartOf("/manga/list", "manga")).toBe("/manga/list");
    expect(counterpartOf("/list", "anime")).toBe("/list");
  });
  it("falls back to the other catalog's home from a title or the reader", () => {
    expect(counterpartOf("/anime/1", "manga")).toBe("/manga");
    expect(counterpartOf("/manga/1", "anime")).toBe("/");
    expect(counterpartOf("/read/mangadex/1/c1", "anime")).toBe("/");
    expect(counterpartOf("/account", "manga")).toBe("/manga");
  });
});
