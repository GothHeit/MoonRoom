import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";

import messages from "../../../messages/en/messages.json";

import { ShareCard } from "./ShareCard";

vi.mock("@/i18n/navigation", () => ({
  Link: ({ href, ...props }: { href: string }) => <a href={href} {...props} />,
}));

const show = { kind: "anime", id: 52991, episode: 4, chapter: null, title: "Frieren", image: null, poster: null, hidden: false } as const;

function renderCard(share: Parameters<typeof ShareCard>[0]["share"]) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <ShareCard share={share} />
    </NextIntlClientProvider>,
  );
}

describe("ShareCard", () => {
  it("names the title and links to play it", () => {
    renderCard(show);
    expect(screen.getByRole("link", { name: "Frieren" })).toHaveAttribute("href", "/anime/52991");
    expect(screen.getByRole("link", { name: "Play" })).toHaveAttribute("href", "/continue/52991/4");
  });

  it("hides an adult title from someone who hides them: no name and no links", () => {
    renderCard({ ...show, id: 0, title: "", hidden: true });
    expect(screen.getByText("A +18 title")).toBeInTheDocument();
    expect(screen.getByText("Episode 4")).toBeInTheDocument();
    expect(screen.queryAllByRole("link")).toHaveLength(0);
  });
});
