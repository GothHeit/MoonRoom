import { NextIntlClientProvider } from "next-intl";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import title from "../../../messages/en/title.json";

import { EpisodeList, pageOf } from "./EpisodeList";

vi.mock("@/i18n/navigation", () => ({
  Link: ({ href, ...props }: { href: string }) => <a href={href} {...props} />,
}));

const episodes = Array.from({ length: 250 }, (_, i) => i + 1);

function renderList(current?: number, art?: Record<string, { title?: string; image?: string }>) {
  return render(
    <NextIntlClientProvider locale="en" messages={title}>
      <EpisodeList
        source="stub"
        animeId={7}
        episodes={episodes}
        current={current}
        art={art}
        progress={[
          {
            anime_id: 7,
            episode: 2,
            position_seconds: 0,
            duration_seconds: 100,
            completed: true,
            updated_at: "2026-10-26T00:00:00Z",
          },
        ]}
      />
    </NextIntlClientProvider>,
  );
}

describe("EpisodeList", () => {
  it("finds the page holding an episode", () => {
    expect(pageOf(episodes, 1)).toBe(0);
    expect(pageOf(episodes, 101)).toBe(1);
    expect(pageOf(episodes, 999)).toBe(0);
  });

  it("links episodes to the player and marks watched ones", () => {
    renderList();
    expect(screen.getByRole("link", { name: /Episode 1$/ })).toHaveAttribute("href", "/watch/stub/7/1");
    expect(screen.getByRole("link", { name: /Episode 2.*Watched/ })).toBeInTheDocument();
    expect(screen.getAllByRole("link")).toHaveLength(100);
  });

  it("shows episode titles and stills from outside the source, and marks the next one", () => {
    const { container } = renderList(3, { 3: { title: "Somewhere She’d Like to Go", image: "https://img/3.jpg" } });
    expect(screen.getByRole("link", { name: /Episode 3.*Up next.*Somewhere She’d Like to Go/ })).toBeInTheDocument();
    expect(container.querySelector('img[src="https://img/3.jpg"]')).not.toBeNull();
  });

  it("opens on the current episode's page and switches pages", async () => {
    renderList(230);
    expect(screen.getByRole("link", { name: /Episode 230/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "1–100" }));
    expect(screen.getByRole("link", { name: /Episode 1$/ })).toBeInTheDocument();
  });
});
