import { fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TvRoot } from "./TvRoot";

const router = vi.hoisted(() => ({ back: vi.fn(), replace: vi.fn() }));
const path = vi.hoisted(() => ({ current: "/tv" }));
vi.mock("@/i18n/navigation", () => ({ useRouter: () => router, usePathname: () => path.current }));
const setFocus = vi.hoisted(() => vi.fn());
vi.mock("./spatial", () => ({ NAV_KEY: "tv-nav", setFocus }));

const back = () => fireEvent.keyDown(window, { keyCode: 10009 });

afterEach(() => {
  router.back.mockReset();
  router.replace.mockReset();
  setFocus.mockReset();
});

describe("TvRoot Back key", () => {
  it("leaves a title page for the screen it came from", () => {
    path.current = "/tv/anime/1";
    render(<TvRoot>x</TvRoot>);
    back();
    // jsdom starts with one history entry, so there is nothing to go back to: Home instead.
    expect(router.replace).toHaveBeenCalledWith("/tv");
  });

  it("moves focus to the top bar first on a top-level screen, then goes Home", () => {
    path.current = "/tv/search";
    const { getByRole } = render(
      <TvRoot>
        <header data-tv-nav>
          <button type="button">Search</button>
        </header>
      </TvRoot>,
    );
    back();
    expect(setFocus).toHaveBeenCalledWith("tv-nav");
    getByRole("button").focus();
    back();
    expect(router.replace).toHaveBeenCalledWith("/tv");
  });

  it("ignores Backspace while typing", () => {
    path.current = "/tv/anime/1";
    const { getByRole } = render(
      <TvRoot>
        <input type="search" aria-label="q" />
      </TvRoot>,
    );
    fireEvent.keyDown(getByRole("searchbox"), { key: "Backspace" });
    expect(router.replace).not.toHaveBeenCalled();
    expect(router.back).not.toHaveBeenCalled();
  });
});
