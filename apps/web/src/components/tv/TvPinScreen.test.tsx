import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TvPinScreen } from "./TvPinScreen";

const client = vi.hoisted(() => ({ POST: vi.fn() }));
const refresh = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ api: client }));
vi.mock("@/i18n/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
vi.mock("next/image", () => ({ default: () => null }));
vi.mock("./TvPage", () => ({ TvPage: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock("./TvGroup", () => ({ TvGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock("./useTvFocus", () => ({ useTvFocus: ({ onEnter }: { onEnter?: () => void }) => ({ ref: { current: null }, focused: false, onEnter }) }));

afterEach(() => {
  client.POST.mockReset();
  refresh.mockReset();
});

const avatar = { kind: "none" as const, version: 0 };

function type(digits: string) {
  for (const d of digits) fireEvent.keyDown(window, { key: d });
}

describe("TvPinScreen", () => {
  it("sends the typed PIN and rebuilds the screens when it is right", async () => {
    client.POST.mockResolvedValue({ response: { ok: true } });
    render(<TvPinScreen userId="u" username="kafka" avatar={avatar} />);
    type("1234");
    fireEvent.click(screen.getByRole("button", { name: "unlock" }));
    await waitFor(() => expect(client.POST).toHaveBeenCalledWith("/auth/pin/unlock", { body: { pin: "1234" } }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("says the PIN is wrong, clears it and stays locked", async () => {
    client.POST.mockResolvedValue({ response: { ok: false }, error: { error: { code: "wrong_pin" } } });
    render(<TvPinScreen userId="u" username="kafka" avatar={avatar} />);
    fireEvent.click(screen.getByRole("button", { name: "1" }));
    type("234");
    fireEvent.click(screen.getByRole("button", { name: "unlock" }));
    expect(await screen.findByText("wrong")).toBeTruthy();
    expect(refresh).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "unlock" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps the unlock button off until four digits are in", () => {
    render(<TvPinScreen userId="u" username="kafka" avatar={avatar} />);
    type("123");
    expect((screen.getByRole("button", { name: "unlock" }) as HTMLButtonElement).disabled).toBe(true);
    type("4");
    expect((screen.getByRole("button", { name: "unlock" }) as HTMLButtonElement).disabled).toBe(false);
  });
});
