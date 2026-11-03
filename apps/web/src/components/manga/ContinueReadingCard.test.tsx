import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderAccount } from "@/test/account-intl";

import { ContinueReadingCard } from "./ContinueReadingCard";

const refresh = vi.fn();
vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ refresh }),
  Link: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}));

const client = vi.hoisted(() => ({ DELETE: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: client }));

const card = { mangaId: 21, href: "/manga/21", title: "Berserk", progress: 0.4 };

afterEach(() => {
  client.DELETE.mockReset();
  refresh.mockClear();
});

describe("ContinueReadingCard", () => {
  it("removes the card and refreshes the page", async () => {
    client.DELETE.mockResolvedValue({ response: { ok: true } });
    renderAccount(<ContinueReadingCard {...card} />);
    fireEvent.click(screen.getByRole("button", { name: /Remove Berserk/ }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(client.DELETE).toHaveBeenCalledWith("/manga/{manga_id}/continue", { params: { path: { manga_id: 21 } } });
    expect(screen.queryByText("Berserk")).toBeNull();
  });

  it("puts the card back when the request fails", async () => {
    client.DELETE.mockResolvedValue({ response: { ok: false } });
    renderAccount(<ContinueReadingCard {...card} />);
    fireEvent.click(screen.getByRole("button", { name: /Remove Berserk/ }));
    await waitFor(() => expect(screen.getByText("Berserk")).toBeTruthy());
    expect(refresh).not.toHaveBeenCalled();
  });
});
