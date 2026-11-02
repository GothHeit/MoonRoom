import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderAccount } from "@/test/account-intl";

import { PlaybackForm } from "./PlaybackForm";

const client = vi.hoisted(() => ({ GET: vi.fn(), PATCH: vi.fn(), PUT: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: client }));

const ok = { data: {}, response: { ok: true } };
const failed = { error: {}, response: { ok: false } };
const base = { audio: "original", subtitle: null, softSubs: true, showSkips: true, maxResolution: null };

afterEach(() => {
  for (const fn of Object.values(client)) fn.mockReset();
});

describe("PlaybackForm", () => {
  it("saves the dub language alone, without touching the other choices", async () => {
    client.PUT.mockResolvedValue(ok);
    renderAccount(<PlaybackForm {...base} />);
    fireEvent.change(screen.getByLabelText(/^Audio/), { target: { value: "pt" } });
    await waitFor(() => expect(client.PUT).toHaveBeenCalledWith("/watch/preferences", { body: { audio_lang: "pt" } }));
    expect(await screen.findByText("Settings saved.")).toBeInTheDocument();
  });

  it("saves the quality limit, and clears it for best", async () => {
    client.PUT.mockResolvedValue(ok);
    renderAccount(<PlaybackForm {...base} maxResolution={720} />);
    const select = screen.getByLabelText(/^Quality/);
    expect(select).toHaveValue("720");
    fireEvent.change(select, { target: { value: "best" } });
    await waitFor(() => expect(client.PUT).toHaveBeenCalledWith("/watch/preferences", { body: { max_resolution: null } }));
  });

  it("saves the subtitle language on the account, where the player reads it", async () => {
    client.PATCH.mockResolvedValue(ok);
    renderAccount(<PlaybackForm {...base} />);
    fireEvent.change(screen.getByLabelText(/^Subtitles/), { target: { value: "off" } });
    await waitFor(() => expect(client.PATCH).toHaveBeenCalledWith("/me", { body: { subtitle_lang: "off" } }));
  });

  it("puts the choice back when saving fails", async () => {
    client.PUT.mockResolvedValue(failed);
    renderAccount(<PlaybackForm {...base} />);
    const toggle = screen.getByRole("switch", { name: "Prefer subtitles I can turn off" });
    fireEvent.click(toggle);
    expect(await screen.findByText("Couldn't save your settings.")).toBeInTheDocument();
    expect(toggle).toHaveAttribute("aria-checked", "true");
  });

  it("keeps a language picked in the player selectable", () => {
    renderAccount(<PlaybackForm {...base} audio="fr" />);
    expect(screen.getByLabelText(/^Audio/)).toHaveValue("fr");
  });
});
