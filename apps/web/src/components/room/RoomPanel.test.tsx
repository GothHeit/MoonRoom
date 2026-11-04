import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";

import messages from "../../../messages/en/room.json";
import { RoomPanel } from "./RoomPanel";
import type { RoomState } from "./useRoom";

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

function setup(meId: string, overrides: Partial<RoomState> = {}) {
  const handlers = {
    onSay: vi.fn(),
    onReact: vi.fn(),
    onVote: vi.fn(),
    onWithdraw: vi.fn(),
    onLock: vi.fn(),
  };
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <RoomPanel room={{ ...room, ...overrides }} meId={meId} messages={[]} episodes={[1, 2, 3]} {...handlers} />
    </NextIntlClientProvider>,
  );
  return handlers;
}

describe("RoomPanel", () => {
  it("shows the code, the people and how many votes an episode has", () => {
    setup("b");
    expect(screen.getByTestId("room-code")).toHaveTextContent("ABC234");
    expect(screen.getByText("friend")).toBeInTheDocument();
    expect(screen.getByText("Episode 3: 1 of 2 votes")).toBeInTheDocument();
  });

  it("lets a guest vote for the leading episode but not lock the controls", async () => {
    const { onVote } = setup("b");
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Vote" }));
    expect(onVote).toHaveBeenCalledWith(3);
  });

  it("lets a guest take back their own vote", async () => {
    const { onWithdraw } = setup("a");
    await userEvent.click(screen.getByRole("button", { name: "Withdraw" }));
    expect(onWithdraw).toHaveBeenCalled();
  });

  it("gives the host the lock and an immediate switch", async () => {
    const { onLock, onVote } = setup("host", { votes: {} });
    await userEvent.click(screen.getByRole("switch"));
    expect(onLock).toHaveBeenCalledWith(true);
    await userEvent.click(screen.getByRole("button", { name: "Switch now" }));
    expect(onVote).toHaveBeenCalledWith(2);
  });

  it("sends a chat message and clears the box", async () => {
    const { onSay } = setup("b");
    await userEvent.type(screen.getByRole("textbox", { name: "Message" }), "hello{enter}");
    expect(onSay).toHaveBeenCalledWith("hello");
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue("");
  });
});
