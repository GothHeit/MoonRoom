import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TvAccountPicker } from "./TvAccountPicker";

const nav = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn(), back: vi.fn(), refresh: vi.fn() }));
vi.mock("@/i18n/navigation", () => ({ useRouter: () => nav }));
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
vi.mock("next/image", () => ({ default: () => null }));
vi.mock("./TvGroup", () => ({ TvGroup: ({ children, className }: { children: React.ReactNode; className?: string }) => <div className={className}>{children}</div> }));
vi.mock("./useTvFocus", () => ({ useTvFocus: ({ onEnter }: { onEnter?: () => void }) => ({ ref: { current: null }, focused: false, onEnter }) }));

const avatar = { kind: "none" as const, version: 0 };
const accounts = [
  { id: "u1", name: "Ana", avatar },
  { id: "u2", name: "Bia", avatar },
];

afterEach(() => {
  vi.unstubAllGlobals();
  Object.values(nav).forEach((fn) => fn.mockReset());
});

describe("TvAccountPicker", () => {
  it("lists the accounts with the add button last", () => {
    render(<TvAccountPicker accounts={accounts} activeId="u1" canAdd fromApp={false} />);
    const names = screen.getAllByRole("button").map((b) => b.getAttribute("aria-label"));
    expect(names).toEqual(["Ana", "Bia", "add"]);
  });

  it("hides the add button and says why when the TV is full", () => {
    render(<TvAccountPicker accounts={accounts} activeId="u1" canAdd={false} fromApp={false} />);
    expect(screen.queryByRole("button", { name: "add" })).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("full");
  });

  it("swaps the account in and rebuilds Home", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    render(<TvAccountPicker accounts={accounts} activeId="u1" canAdd fromApp={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Bia" }));
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith("/tv"));
    expect(fetch).toHaveBeenCalledWith("/api/tv/accounts/switch", expect.objectContaining({ body: JSON.stringify({ id: "u2" }) }));
    expect(nav.refresh).toHaveBeenCalled();
  });

  it("explains an expired sign-in and reloads the list", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: { code: "account_expired", message: "x" } }, { status: 410 })));
    render(<TvAccountPicker accounts={accounts} activeId="u1" canAdd fromApp={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Bia" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("expired"));
    expect(nav.replace).not.toHaveBeenCalled();
    expect(nav.refresh).toHaveBeenCalled();
  });

  it("goes back when the current account is picked again from Settings", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    render(<TvAccountPicker accounts={accounts} activeId="u1" canAdd fromApp />);
    fireEvent.click(screen.getByRole("button", { name: "Ana" }));
    expect(nav.back).toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("opens the add screen from the plus", () => {
    render(<TvAccountPicker accounts={accounts} activeId="u1" canAdd fromApp={false} />);
    fireEvent.click(screen.getByRole("button", { name: "add" }));
    expect(nav.push).toHaveBeenCalledWith("/tv/accounts/add");
  });
});
