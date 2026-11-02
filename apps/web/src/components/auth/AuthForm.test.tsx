import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderIntl } from "@/test/intl";

import { LoginForm } from "./LoginForm";

const replace = vi.fn();
vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ replace, refresh: vi.fn() }),
}));

function setup() {
  renderIntl(<LoginForm />);
  fireEvent.change(screen.getByLabelText("Username"), { target: { value: "kafka" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "password123" } });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  replace.mockClear();
});

describe("LoginForm", () => {
  it("posts to the web server and goes home on success", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    setup();
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/"));
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/login", expect.objectContaining({ method: "POST" }));
  });

  it("shows the translated API error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: { code: "invalid_credentials", message: "x" } }, { status: 401 })),
    );
    setup();
    expect(await screen.findByRole("alert")).toHaveTextContent("Wrong username or password.");
    expect(replace).not.toHaveBeenCalled();
  });

  it("shows a network error when the server is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("offline"))));
    setup();
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't reach the server.");
  });

  it("asks for the code after the password, then signs in", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ mfa_required: true, mfa_token: "challenge" }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    setup();
    fireEvent.change(await screen.findByLabelText("Code"), { target: { value: "123456" } });
    fireEvent.click(screen.getByLabelText("Trust this device for 30 days"));
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/"));
    expect(fetchMock.mock.calls[1][0]).toBe("/api/auth/login/2fa");
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      code: "123456",
      trust_device: "on",
      mfa_token: "challenge",
    });
  });
});
