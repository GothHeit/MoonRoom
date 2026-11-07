import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TvPinEditor } from "./TvPinEditor";

const client = vi.hoisted(() => ({ PUT: vi.fn(), POST: vi.fn() }));
const nav = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: client }));
vi.mock("@/i18n/navigation", () => ({ useRouter: () => nav }));
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
vi.mock("./TvGroup", () => ({
  TvGroup: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));
vi.mock("./useTvFocus", () => ({
  useTvFocus: ({ onEnter }: { onEnter?: () => void }) => ({
    ref: { current: null },
    focused: false,
    onEnter,
  }),
}));

afterEach(() => {
  client.PUT.mockReset();
  client.POST.mockReset();
  nav.refresh.mockReset();
});

const type = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(new RegExp(label)), {
    target: { value },
  });

describe("TvPinEditor", () => {
  it("adds a first PIN with the account password", async () => {
    client.PUT.mockResolvedValue({ response: { ok: true } });
    const onDone = vi.fn();
    render(<TvPinEditor pinEnabled={false} busy={false} onDone={onDone} />);
    expect(screen.queryByText("pinRemove")).toBeNull();
    fireEvent.click(screen.getByText("pinAdd"));
    type("pinPassword", "secret");
    type("pinNew", "1234");
    fireEvent.click(screen.getByText("pinSave"));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith("saved"));
    expect(client.PUT).toHaveBeenCalledWith("/auth/pin/tv", {
      body: { pin: "1234", password: "secret" },
    });
    expect(nav.refresh).toHaveBeenCalled();
  });

  it("changes the PIN with the current one and shows a wrong PIN", async () => {
    client.PUT.mockResolvedValueOnce({
      response: { ok: false },
      error: { error: { code: "wrong_pin" } },
    });
    render(<TvPinEditor pinEnabled busy={false} onDone={vi.fn()} />);
    fireEvent.click(screen.getByText("pinChange"));
    type("pinCurrent", "0000");
    type("pinNew", "5678");
    fireEvent.click(screen.getByText("pinSave"));
    expect((await screen.findByRole("alert")).textContent).toBe("pinWrong");
    expect(client.PUT).toHaveBeenCalledWith("/auth/pin/tv", {
      body: { pin: "5678", current_pin: "0000" },
    });
  });

  it("removes the PIN with the current one", async () => {
    client.POST.mockResolvedValue({ response: { ok: true } });
    const onDone = vi.fn();
    render(<TvPinEditor pinEnabled busy={false} onDone={onDone} />);
    fireEvent.click(screen.getByText("pinRemove"));
    type("pinCurrent", "1234");
    fireEvent.click(screen.getByText("pinConfirmRemove"));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith("removed"));
    expect(client.POST).toHaveBeenCalledWith("/auth/pin/tv/remove", {
      body: { current_pin: "1234" },
    });
  });
});
