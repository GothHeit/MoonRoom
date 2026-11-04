import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";

import intl from "../../../messages/en/room.json";
import { RoomPanel, type PanelTab } from "./RoomPanel";
import type { ChatLine, RoomState } from "./useRoom";

const room: RoomState = {
  code: "ABC234",
  host_id: "host",
  source: "zoko",
  anime_id: 21,
  title: "One Piece",
  episode: 1,
  lang: "sub",
  locked: false,
  members: [
    { id: "host", username: "kafka" },
    { id: "a", username: "friend" },
    { id: "b", username: "other" },
  ],
  votes: { a: 3 },
  buffering: [],
  playback: { playing: false, position: 0, at: 0, version: 1, by: null },
  revision: 1,
};

function setup(meId: string, overrides: Partial<RoomState> = {}, tab: PanelTab = "episode", messages: ChatLine[] = []) {
  const handlers = {
    onTab: vi.fn(),
    onSay: vi.fn(),
    onReact: vi.fn(),
    onVote: vi.fn(),
    onWithdraw: vi.fn(),
    onLock: vi.fn(),
  };
  render(
    <NextIntlClientProvider locale="en" messages={intl}>
      <RoomPanel room={{ ...room, ...overrides }} meId={meId} messages={messages} episodes={[1, 2, 3]} tab={tab} {...handlers} />
    </NextIntlClientProvider>,
  );
  return handlers;
}

describe("RoomPanel", () => {
  it("shows the people, who is host and the code to share", () => {
    setup("b", { buffering: ["a"] }, "people");
    expect(screen.getByTestId("room-code")).toHaveTextContent("ABC234");
    expect(screen.getByText("friend")).toBeInTheDocument();
    expect(screen.getByText("host")).toBeInTheDocument();
    expect(screen.getByText("(you)")).toBeInTheDocument();
    expect(screen.getByText("loading")).toBeInTheDocument();
  });

  it("shows how many votes an episode has", () => {
    setup("b");
    expect(screen.getByText("Episode 3: 1 of 2 votes")).toBeInTheDocument();
  });

  it("switches tabs", async () => {
    const { onTab } = setup("b", {}, "chat");
    expect(screen.getByRole("tab", { name: "Chat" })).toHaveAttribute("aria-selected", "true");
    await userEvent.click(screen.getByRole("tab", { name: /People/ }));
    expect(onTab).toHaveBeenCalledWith("people");
  });

  it("shows what happened in the room between the messages", () => {
    setup("b", {}, "chat", [
      { id: "e1", event: true, kind: "joined", name: "friend" },
      { id: "m1", user_id: "a", username: "friend", text: "hi all", reaction: false },
      { id: "e2", event: true, kind: "paused", name: "kafka", position: 544 },
      { id: "e3", event: true, kind: "episode", episode: 2 },
    ]);
    expect(screen.getByText("friend joined")).toBeInTheDocument();
    expect(screen.getByText("hi all")).toBeInTheDocument();
    expect(screen.getByText("kafka paused at 9:04")).toBeInTheDocument();
    expect(screen.getByText("Episode 2 is starting")).toBeInTheDocument();
  });

  it("lets a guest vote for the leading episode but not lock the controls", async () => {
    setup("b", {}, "people");
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    cleanup();
    const { onVote } = setup("b");
    await userEvent.click(screen.getByRole("button", { name: "Vote" }));
    expect(onVote).toHaveBeenCalledWith(3);
  });

  it("lets a guest take back their own vote", async () => {
    const { onWithdraw } = setup("a");
    await userEvent.click(screen.getByRole("button", { name: "Withdraw" }));
    expect(onWithdraw).toHaveBeenCalled();
  });

  it("gives the host the lock and an immediate switch", async () => {
    const { onLock } = setup("host", { votes: {} }, "people");
    await userEvent.click(screen.getByRole("switch"));
    expect(onLock).toHaveBeenCalledWith(true);
    cleanup();
    const { onVote } = setup("host", { votes: {} });
    await userEvent.click(screen.getByRole("button", { name: "Switch now" }));
    expect(onVote).toHaveBeenCalledWith(2);
  });

  it("sends a chat message and clears the box", async () => {
    const { onSay } = setup("b", {}, "chat");
    await userEvent.type(screen.getByRole("textbox", { name: "Message" }), "hello{enter}");
    expect(onSay).toHaveBeenCalledWith("hello");
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue("");
  });
});
