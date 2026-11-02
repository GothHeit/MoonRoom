import { act, fireEvent, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderIntl } from "@/test/intl";

import { HeroCarousel } from "./HeroCarousel";

vi.mock("@/i18n/navigation", () => ({
  Link: ({ href, ...props }: { href: string }) => <a href={href} {...props} />,
}));

const slides = [
  { id: 1, title: "Frieren", href: "/anime/1" },
  { id: 2, title: "Dungeon Meshi", href: "/anime/2" },
];

beforeEach(() => {
  window.matchMedia = vi.fn().mockReturnValue({
    matches: true,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }) as unknown as typeof window.matchMedia;
});

describe("HeroCarousel", () => {
  it("shows the first title as the page heading", () => {
    renderIntl(<HeroCarousel slides={slides} cta="Watch now" />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Frieren");
  });

  it("switches title when a dot is pressed", () => {
    renderIntl(<HeroCarousel slides={slides} cta="Watch now" />);
    fireEvent.click(screen.getAllByRole("button")[1]);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Dungeon Meshi");
  });

  it("has no dots for a single title", () => {
    renderIntl(<HeroCarousel slides={slides.slice(0, 1)} cta="Watch now" />);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("loads only the first picture at first, then the one coming next", () => {
    vi.useFakeTimers();
    const art = [1, 2, 3].map((id) => ({ id, title: `T${id}`, href: `/anime/${id}`, wideArt: `/art/${id}.jpg` }));
    const { container } = renderIntl(<HeroCarousel slides={art} cta="Watch now" />);
    const sources = () => [...container.querySelectorAll("img")].map((img) => img.getAttribute("src"));
    expect(sources()).toEqual(["/art/1.jpg"]);
    act(() => void vi.advanceTimersByTime(1600));
    expect(sources()).toEqual(["/art/1.jpg", "/art/2.jpg"]);
    vi.useRealTimers();
  });
});
