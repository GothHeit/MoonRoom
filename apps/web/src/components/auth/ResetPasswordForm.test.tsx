import { fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderIntl } from "@/test/intl";

import { ResetPasswordForm } from "./ResetPasswordForm";

vi.mock("@/i18n/navigation", () => ({
  Link: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}));

beforeEach(() => {
  window.history.replaceState(null, "", "/en/reset-password#tok%20en");
});
afterEach(() => vi.unstubAllGlobals());

const sent = (mock: { mock: { calls: unknown[][] } }, i: number) =>
  JSON.parse(String((mock.mock.calls[i]?.[1] as RequestInit | undefined)?.body));

const fill = (a: string, b: string) => {
  fireEvent.change(screen.getByLabelText("New password"), { target: { value: a } });
  fireEvent.change(screen.getByLabelText("Repeat the new password"), { target: { value: b } });
};

describe("ResetPasswordForm", () => {
  it("checks the link, then saves the new password and clears the address", async () => {
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async (url) =>
      url.endsWith("/check") ? Response.json({ username: "friend" }) : new Response(null, { status: 204 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    renderIntl(<ResetPasswordForm />);
    expect(await screen.findByText("Choose a new password for friend.")).toBeInTheDocument();
    expect(sent(fetchMock, 0)).toEqual({ token: "tok en" });
    fill("brand-new-pass", "brand-new-pass");
    fireEvent.click(screen.getByRole("button", { name: "Save password" }));
    expect(await screen.findByText("Password changed")).toBeInTheDocument();
    expect(sent(fetchMock, 1)).toEqual({ token: "tok en", new_password: "brand-new-pass" });
    expect(window.location.hash).toBe("");
  });

  it("refuses two different passwords without calling the server", async () => {
    const fetchMock = vi.fn(async () => Response.json({ username: "friend" }));
    vi.stubGlobal("fetch", fetchMock);
    renderIntl(<ResetPasswordForm />);
    await screen.findByText("Choose a new password for friend.");
    fill("brand-new-pass", "different-pass");
    fireEvent.click(screen.getByRole("button", { name: "Save password" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The two passwords don't match.");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("explains a dead link", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: { code: "invalid_reset_link", message: "x" } }, { status: 400 })));
    renderIntl(<ResetPasswordForm />);
    expect(await screen.findByText("This link doesn't work")).toBeInTheDocument();
  });

  it("treats an address without a token as a dead link", async () => {
    window.history.replaceState(null, "", "/en/reset-password");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    renderIntl(<ResetPasswordForm />);
    expect(await screen.findByText("This link doesn't work")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
