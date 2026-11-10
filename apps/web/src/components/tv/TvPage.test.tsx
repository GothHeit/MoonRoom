import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TvPage } from "./TvPage";

const nav = vi.hoisted(() => ({
  current: "tv-page",
  live: new Set<string>(["tv-nav"]),
  page: { current: null as HTMLElement | null },
}));
const setFocus = vi.hoisted(() =>
  vi.fn((key: string) => {
    nav.current = key === "tv-nav" ? "tv-tab-/tv/list" : key;
  }),
);
vi.mock("@noriginmedia/norigin-spatial-navigation", async () => {
  const { createContext } = await import("react");
  return {
    FocusContext: createContext(""),
    useFocusable: () => ({ ref: nav.page, focusKey: "tv-page" }),
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
  nav.live = new Set(["tv-nav"]);
  nav.page.current = null;
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

  it("keeps waiting for the initial item while its placeholder shows, then focuses it", () => {
    const { rerender } = render(
      <TvPage initial="tv-play">
        <div data-tv-pending />
        <button data-tv-key="tv-other" />
      </TvPage>,
    );
    act(() => void vi.advanceTimersByTime(4000));
    expect(setFocus).not.toHaveBeenCalled();
    nav.live.add("tv-play");
    rerender(
      <TvPage initial="tv-play">
        <button data-tv-key="tv-play" />
        <button data-tv-key="tv-other" />
      </TvPage>,
    );
    act(() => void vi.advanceTimersByTime(100));
    expect(setFocus).toHaveBeenCalledWith("tv-play");
  });

  it("settles for the first main item when the initial one never comes", () => {
    render(
      <TvPage initial="tv-play">
        <button data-tv-key="tv-more" data-tv-aside />
        <button data-tv-key="tv-other" />
      </TvPage>,
    );
    act(() => void vi.advanceTimersByTime(2000));
    expect(setFocus).toHaveBeenCalledWith("tv-other");
  });
});
