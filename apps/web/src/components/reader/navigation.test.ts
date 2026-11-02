import { describe, expect, it } from "vitest";

import { clampPage, loadSettings, saveSettings, stepFromKey, swipeStep, zoneOf } from "./navigation";

describe("reader navigation", () => {
  it("turns arrow keys the way the book reads", () => {
    expect(stepFromKey("ArrowRight", "ltr")).toBe(1);
    expect(stepFromKey("ArrowRight", "rtl")).toBe(-1);
    expect(stepFromKey("ArrowLeft", "rtl")).toBe(1);
    expect(stepFromKey(" ", "rtl")).toBe(1);
    expect(stepFromKey("PageUp", "ltr")).toBe(-1);
    expect(stepFromKey("a", "ltr")).toBe(0);
  });

  it("pages from the sides and toggles from the middle", () => {
    expect(zoneOf(0.1, "ltr")).toBe("back");
    expect(zoneOf(0.1, "rtl")).toBe("forward");
    expect(zoneOf(0.9, "ltr")).toBe("forward");
    expect(zoneOf(0.5, "rtl")).toBe("toggle");
  });

  it("reads a swipe as revealing the page on the other side", () => {
    expect(swipeStep(-80, 5, "ltr")).toBe(1);
    expect(swipeStep(-80, 5, "rtl")).toBe(-1);
    expect(swipeStep(80, 5, "rtl")).toBe(1);
    expect(swipeStep(-30, 5, "ltr")).toBe(0);
    expect(swipeStep(-80, 70, "ltr")).toBe(0);
  });

  it("keeps the page inside the chapter", () => {
    expect(clampPage(-1, 10)).toBe(0);
    expect(clampPage(12, 10)).toBe(9);
    expect(clampPage(0, 0)).toBe(0);
  });

  it("remembers the settings per title and ignores junk", () => {
    const defaults = { mode: "page", direction: "rtl" } as const;
    expect(loadSettings(7, defaults)).toEqual(defaults);
    saveSettings(7, { mode: "strip", direction: "ltr" });
    expect(loadSettings(7, defaults)).toEqual({ mode: "strip", direction: "ltr" });
    localStorage.setItem("mr:reader:8", '{"mode":"sideways"}');
    expect(loadSettings(8, defaults)).toEqual(defaults);
    localStorage.setItem("mr:reader:9", "not json");
    expect(loadSettings(9, defaults)).toEqual(defaults);
  });
});
