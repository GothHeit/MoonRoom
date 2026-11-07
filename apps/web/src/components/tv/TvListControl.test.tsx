import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TvListControl } from "./TvListControl";

const api = vi.hoisted(() => ({ setStatus: vi.fn(), removeEntry: vi.fn() }));
vi.mock("@/components/list/listApi", () => api);
vi.mock("@/components/list/useErrorMessage", () => ({ useErrorMessage: () => (code: string) => `err:${code}` }));
vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));
vi.mock("./spatial", () => ({ setFocus: vi.fn() }));
vi.mock("./useTvFocus", () => ({ useTvFocus: ({ onEnter }: { onEnter?: () => void }) => ({ ref: { current: null }, focused: false, onEnter }) }));
vi.mock("./player/TvPlayerMenu", () => ({
  TvPlayerMenu: ({ sections }: { sections: { options: { key: string; label: string; onPick: () => void }[] }[] }) => (
    <ul>
      {sections[0].options.map((o) => (
        <li key={o.key}>
          <button onClick={o.onPick}>{o.label}</button>
        </li>
      ))}
    </ul>
  ),
}));

afterEach(() => vi.clearAllMocks());

describe("TvListControl", () => {
  it("shows the add label for a title not on the list and saves a pick", async () => {
    api.setStatus.mockResolvedValue(null);
    render(<TvListControl animeId={7} initial={null} />);
    fireEvent.click(screen.getByRole("button", { name: /add/ }));
    expect(screen.queryByText("remove")).toBeNull();
    fireEvent.click(screen.getByText("status.watching"));
    await waitFor(() => expect(api.setStatus).toHaveBeenCalledWith(7, "watching"));
    await waitFor(() => expect(screen.getByRole("button", { name: /status.watching/ })).toBeTruthy());
  });

  it("removes the title and keeps the old status when saving fails", async () => {
    api.removeEntry.mockResolvedValue("mal_update_failed");
    render(<TvListControl animeId={7} initial="completed" />);
    fireEvent.click(screen.getByRole("button", { name: /status.completed/ }));
    fireEvent.click(screen.getByText("remove"));
    await waitFor(() => expect(api.removeEntry).toHaveBeenCalledWith(7));
    expect(await screen.findByText("err:mal_update_failed")).toBeTruthy();
    expect(screen.getByRole("button", { name: /status.completed/ })).toBeTruthy();
  });
});
