import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it, vi } from "vitest";

import notificationMessages from "../../../messages/en/notifications.json";

import { NotificationBell } from "./NotificationBell";

vi.mock("@/i18n/navigation", () => ({
  Link: ({ children, href, onClick, ...rest }: { children: React.ReactNode; href: string; onClick?: () => void }) => (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault();
        onClick?.();
      }}
      {...rest}
    >
      {children}
    </a>
  ),
}));

const client = vi.hoisted(() => ({ GET: vi.fn(), POST: vi.fn(), DELETE: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: client }));

const none = { kind: "none", version: 0 } as const;
const base = { read: false, created_at: new Date().toISOString(), anime_id: null, manga_id: null, episode: null, title: null, room_code: null, room_active: null, actor: null };
const friend = { ...base, id: "n1", kind: "friend_request", actor: { id: "u2", username: "ana", avatar: none } };
const room = { ...base, id: "n2", kind: "room_invite", room_code: "ABC123", title: "One Piece", episode: 3, room_active: true, actor: { id: "u3", username: "bob", avatar: none } };
const chapter = { ...base, id: "n4", kind: "new_chapter", manga_id: 9, episode: 12, title: "Running Manga" };
const episode = { ...base, id: "n3", kind: "new_episode", anime_id: 5, episode: 4, title: "Airing Show" };

afterEach(() => {
  cleanup();
  for (const fn of Object.values(client)) fn.mockReset();
});

function renderBell() {
  return render(
    <NextIntlClientProvider locale="en" messages={notificationMessages}>
      <NotificationBell />
    </NextIntlClientProvider>,
  );
}

describe("NotificationBell", () => {
  it("shows the unread count and lists what happened", async () => {
    client.GET.mockResolvedValue({ data: { items: [friend, room, episode, chapter], unread: 4 } });
    renderBell();
    const button = await screen.findByRole("button", { name: "Notifications, 4 unread" });
    fireEvent.click(button);
    expect(await screen.findByText("ana wants to be your friend")).toBeInTheDocument();
    expect(screen.getByText("bob invited you to watch together")).toBeInTheDocument();
    expect(screen.getByText("One Piece, episode 3")).toBeInTheDocument();
    expect(screen.getByText("New episode of Airing Show")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /bob invited you/ })).toHaveAttribute("href", "/room/ABC123");
    expect(screen.getByRole("link", { name: /Airing Show/ })).toHaveAttribute("href", "/anime/5");
    expect(screen.getByText("New chapter of Running Manga")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Running Manga/ })).toHaveAttribute("href", "/manga/9");
  });

  it("marks an entry read when it is opened and everything read on request", async () => {
    client.GET.mockResolvedValue({ data: { items: [friend, episode], unread: 2 } });
    client.POST.mockResolvedValue({ response: { ok: true } });
    renderBell();
    fireEvent.click(await screen.findByRole("button", { name: "Notifications, 2 unread" }));
    fireEvent.click(await screen.findByRole("link", { name: /ana wants/ }));
    expect(client.POST).toHaveBeenCalledWith("/notifications/{notification_id}/read", { params: { path: { notification_id: "n1" } } });
    fireEvent.click(await screen.findByRole("button", { name: "Notifications, 1 unread" }));
    fireEvent.click(screen.getByRole("button", { name: "Mark all as read" }));
    expect(client.POST).toHaveBeenCalledWith("/notifications/read");
    await waitFor(() => expect(screen.getByRole("button", { name: "Notifications" })).toBeInTheDocument());
  });

  it("dismisses an entry and says when a room has closed", async () => {
    client.GET.mockResolvedValue({ data: { items: [{ ...room, room_active: false }, friend], unread: 2 } });
    client.DELETE.mockResolvedValue({ response: { ok: true } });
    renderBell();
    fireEvent.click(await screen.findByRole("button", { name: "Notifications, 2 unread" }));
    expect(await screen.findByText("This room has closed.")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /bob invited you/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss: bob invited you to watch together" }));
    await waitFor(() => expect(screen.queryByText("bob invited you to watch together")).toBeNull());
    expect(client.DELETE).toHaveBeenCalledWith("/notifications/{notification_id}", { params: { path: { notification_id: "n2" } } });
  });

  it("says so when there is nothing", async () => {
    client.GET.mockResolvedValue({ data: { items: [], unread: 0 } });
    renderBell();
    fireEvent.click(await screen.findByRole("button", { name: "Notifications" }));
    expect(await screen.findByText("You're all caught up.")).toBeInTheDocument();
  });

  it("moves focus into the panel and back to the bell on Escape", async () => {
    client.GET.mockResolvedValue({ data: { items: [friend], unread: 1 } });
    renderBell();
    const bell = await screen.findByRole("button", { name: "Notifications, 1 unread" });
    fireEvent.click(bell);
    const dialog = await screen.findByRole("dialog", { name: "Notifications" });
    await waitFor(() => expect(dialog).toHaveFocus());
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(bell).toHaveFocus();
  });

  it("does not let a poll that started before a dismissal bring the entry back", async () => {
    client.GET.mockResolvedValueOnce({ data: { items: [friend], unread: 1 } });
    client.DELETE.mockResolvedValue({ response: { ok: true } });
    renderBell();
    const bell = await screen.findByRole("button", { name: "Notifications, 1 unread" });
    let finish: (value: unknown) => void = () => undefined;
    client.GET.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    fireEvent.click(bell); // starts a poll that is still waiting
    fireEvent.click(await screen.findByRole("button", { name: "Dismiss: ana wants to be your friend" }));
    finish({ data: { items: [friend], unread: 1 } }); // the old answer arrives late
    await waitFor(() => expect(client.DELETE).toHaveBeenCalled());
    expect(screen.queryByText("ana wants to be your friend")).toBeNull();
  });

  it("keeps showing the list but says so when a refresh fails", async () => {
    client.GET.mockResolvedValueOnce({ data: { items: [friend], unread: 1 } });
    renderBell();
    const bell = await screen.findByRole("button", { name: "Notifications, 1 unread" });
    client.GET.mockRejectedValueOnce(new Error("offline"));
    fireEvent.click(bell);
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load notifications.");
    expect(screen.getByText("ana wants to be your friend")).toBeInTheDocument();
  });
});
