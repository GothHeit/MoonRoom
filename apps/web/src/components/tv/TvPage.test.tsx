import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TvPage } from "./TvPage";

const nav = vi.hoisted(() => ({ current: "tv-page", live: new Set<string>(["tv-nav"]) }));
const setFocus = vi.hoisted(() =>
  vi.fn((key: string) => {
    nav.current = key === "tv-nav" ? "tv-tab-/tv/list" : key;
  }),
);
vi.mock("@noriginmedia/norigin-spatial-navigation", async () => {
  const { createContext } = await import("react");
  return {
    FocusContext: createContext(""),
    useFocusable: () => ({ ref: { current: null }, focusKey: "tv-page" }),
    getCurrentFocusKey: () => nav.current,
    doesFocusableExist: (key: string) => nav.live.has(key),
  };
});
vi.mock("./spatial", () => ({ NAV_KEY: "tv-nav", PAGE_KEY: "tv-page", recallFocus: () => undefined, setFocus }));
vi.mock("@/i18n/navigation", () => ({ usePathname: () => "/tv/list" }));

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  setFocus.mockClear();
  nav.current = "tv-page";
});

describe("TvPage arrival focus", () => {
  it("hands focus to the top bar when the screen has nothing to focus", () => {
    render(<TvPage>empty</TvPage>);
    act(() => void vi.advanceTimersByTime(1000));
    expect(setFocus).toHaveBeenCalledWith("tv-nav");
  });

  it("leaves the top bar alone on the sign-in screen, which has none", () => {
    render(<TvPage bare>empty</TvPage>);
    act(() => void vi.advanceTimersByTime(1000));
    expect(setFocus).not.toHaveBeenCalled();
  });
});
