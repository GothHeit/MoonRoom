import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import common from "../../../messages/en/common.json";
import comments from "../../../messages/en/comments.json";
import { ToastProvider } from "@/components/ui/Toast";
import { commentHref, type CommentOut } from "@/lib/comments";

import { CommentsPanel } from "./CommentsPanel";

vi.mock("@/i18n/navigation", () => ({
  Link: ({ children, href, ...rest }: { children: ReactNode; href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const client = vi.hoisted(() => ({ GET: vi.fn(), POST: vi.fn(), PUT: vi.fn(), DELETE: vi.fn(), PATCH: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: client }));

const none = { kind: "none", version: 0 } as const;
const person = (id: string, username: string) => ({ id, username, avatar: none });
const at = "2026-11-23T20:00:00Z";

function comment(id: string, user: ReturnType<typeof person>, body: string, extra: Partial<CommentOut> = {}): CommentOut {
  return { id, user, body, spoiler: false, created_at: at, edited_at: null, mine: false, reactions: [], replies: [], ...extra };
}

afterEach(() => {
  cleanup();
  for (const fn of Object.values(client)) fn.mockReset();
});

function renderPanel() {
  return render(
    <NextIntlClientProvider locale="en" messages={{ ...common, ...comments }}>
      <ToastProvider>
        <CommentsPanel scope={{ kind: "episode", animeId: 1, episode: 5 }} title="Frieren" onClose={() => undefined} />
      </ToastProvider>
    </NextIntlClientProvider>,
  );
}

describe("CommentsPanel", () => {
  it("keeps the comments shut until the episode is finished, naming who wrote some", async () => {
    client.GET.mockResolvedValue({
      data: { items: [], total: 3, next: null, locked: true, people: [person("a", "junior"), person("b", "pondofe")] },
    });
    renderPanel();
    expect(await screen.findByRole("heading", { name: "Finish the episode first" })).toBeInTheDocument();
    expect(screen.getByText(/junior and pondofe left 3 comments/)).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(client.GET).toHaveBeenCalledWith("/anime/{anime_id}/episodes/{episode}/comments", {
      params: { path: { anime_id: 1, episode: 5 }, query: { limit: 20 } },
    });
  });

  it("folds long reply threads, sends a reply and toggles a reaction", async () => {
    const replies = ["r1", "r2", "r3", "r4"].map((id, i) => comment(id, person("b", "pondofe"), `reply ${i + 1}`));
    const first = comment("c1", person("a", "junior"), "That ending!", {
      replies,
      reactions: [{ kind: "heart", count: 2, mine: false }],
    });
    client.GET.mockResolvedValue({ data: { items: [first], total: 1, next: null, locked: false, people: [first.user] } });
    renderPanel();

    expect(await screen.findByText("That ending!")).toBeInTheDocument();
    expect(screen.getByText("reply 2")).toBeInTheDocument();
    expect(screen.queryByText("reply 3")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "View 2 more replies" }));
    expect(screen.getByText("reply 4")).toBeInTheDocument();

    client.PUT.mockResolvedValue({ data: [{ kind: "heart", count: 3, mine: true }] });
    fireEvent.click(screen.getByRole("button", { name: "Love, 2" }));
    expect(await screen.findByRole("button", { name: "Love, 3" })).toHaveAttribute("aria-pressed", "true");
    expect(client.PUT).toHaveBeenCalledWith("/comments/{comment_id}/reactions/{kind}", { params: { path: { comment_id: "c1", kind: "heart" } } });

    client.POST.mockResolvedValue({ data: comment("r5", person("me", "kafka"), "Same!", { mine: true }) });
    fireEvent.click(screen.getAllByRole("button", { name: "Reply" })[0]);
    fireEvent.change(screen.getByLabelText("Write a reply"), { target: { value: "Same!" } });
    fireEvent.submit(screen.getByLabelText("Write a reply").closest("form")!);
    await waitFor(() => expect(screen.getByText("Same!")).toBeInTheDocument());
    expect(client.POST).toHaveBeenCalledWith("/comments/{comment_id}/replies", { params: { path: { comment_id: "c1" } }, body: { body: "Same!" } });
  });
});

describe("commentHref", () => {
  it("points at the part a reply was on, or the title's comments", () => {
    expect(commentHref({ anime_id: 1, episode: 5, comment_id: "x" })).toBe("/anime/1?comment=x&ep=5");
    expect(commentHref({ manga_id: 2, chapter: "12.5", comment_id: "x" })).toBe("/manga/2?comment=x&ch=12.5");
    expect(commentHref({ anime_id: 1, comment_id: "x" })).toBe("/anime/1?comment=x");
  });
});
