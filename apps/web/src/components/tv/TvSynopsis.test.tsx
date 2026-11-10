import { act, fireEvent, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it, vi } from "vitest";

import common from "../../../messages/en/common.json";
import title from "../../../messages/en/title.json";

import { TvSynopsis } from "./TvSynopsis";

vi.mock("./useTvFocus", async () => {
  const { useRef } = await import("react");
  return { useTvFocus: () => ({ ref: useRef(null), focused: false }) };
});
vi.mock("./spatial", () => ({ setFocus: vi.fn() }));

const heights = { scroll: 0, client: 0 };
Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get: () => heights.scroll });
Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => heights.client });

const show = () =>
  render(
    <NextIntlClientProvider locale="en" messages={{ ...common, ...title }}>
      <TvSynopsis title="Frieren" text={"First part.\n\nSecond part."} />
    </NextIntlClientProvider>,
  );

afterEach(() => {
  heights.scroll = 0;
  heights.client = 0;
});

describe("TvSynopsis", () => {
  it("offers nothing more when the text fits", () => {
    heights.scroll = 100;
    heights.client = 100;
    show();
    expect(screen.queryByRole("button", { name: "Read more" })).toBeNull();
  });

  it("opens the whole text when it is cut, and OK or Back closes it without reaching the page", () => {
    heights.scroll = 300;
    heights.client = 100;
    show();
    fireEvent.click(screen.getByRole("button", { name: "Read more" }));
    expect(screen.getByRole("dialog", { name: "Synopsis: Frieren" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();

    const reachedPage = vi.fn();
    window.addEventListener("keydown", reachedPage);
    act(() => void fireEvent.keyDown(document.body, { key: "ArrowDown" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    act(() => void fireEvent.keyDown(document.body, { key: "Enter" }));
    window.removeEventListener("keydown", reachedPage);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(reachedPage).not.toHaveBeenCalled();
  });
});
