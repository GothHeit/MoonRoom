import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import common from "../../../messages/en/common.json";
import tv from "../../../messages/en/tv.json";

import { formatCode, LinkDevice } from "./LinkDevice";

vi.mock("@/i18n/navigation", () => ({ Link: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a> }));
const client = vi.hoisted(() => ({ POST: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: client }));

const TIZEN = "Mozilla/5.0 (SMART-TV; LINUX; Tizen 7.0) AppleWebKit/537.36 TV Safari/537.36";
const renderLink = (code = "") =>
  render(
    <NextIntlClientProvider locale="en" messages={{ ...common, ...tv }} timeZone="UTC" now={new Date()}>
      <LinkDevice initialCode={code} />
    </NextIntlClientProvider>,
  );

afterEach(() => client.POST.mockReset());

describe("formatCode", () => {
  it("writes a typed code the way the TV shows it", () => {
    expect(formatCode("bcdf ghjk")).toBe("BCDF-GHJK");
    expect(formatCode("BCDF-GHJKX")).toBe("BCDF-GHJK");
    expect(formatCode("bc")).toBe("BC");
  });
});

describe("LinkDevice", () => {
  it("shows which TV asked, then approves it", async () => {
    client.POST.mockResolvedValueOnce({ data: { user_agent: TIZEN, ip: "1.2.3.4", created_at: new Date().toISOString(), expires_at: new Date().toISOString() } });
    client.POST.mockResolvedValueOnce({ response: { ok: true } });
    renderLink("bcdfghjk");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText("Samsung TV")).toBeInTheDocument();
    expect(client.POST).toHaveBeenCalledWith("/auth/device/lookup", { body: { code: "BCDF-GHJK" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in the TV" }));
    expect(await screen.findByText("Your TV is signed in")).toBeInTheDocument();
    expect(client.POST).toHaveBeenLastCalledWith("/auth/device/approve", { body: { code: "BCDF-GHJK" } });
  });

  it("declines a TV the person doesn't recognise", async () => {
    client.POST.mockResolvedValueOnce({ data: { user_agent: null, ip: null, created_at: new Date().toISOString(), expires_at: new Date().toISOString() } });
    client.POST.mockResolvedValueOnce({ response: { ok: true } });
    renderLink("BCDF-GHJK");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(await screen.findByRole("button", { name: "Not me, decline" }));
    await waitFor(() => expect(client.POST).toHaveBeenLastCalledWith("/auth/device/deny", { body: { code: "BCDF-GHJK" } }));
    expect(await screen.findByText("Declined")).toBeInTheDocument();
  });

  it("says so when the code is wrong", async () => {
    client.POST.mockResolvedValueOnce({ error: { error: { code: "device_code_invalid", message: "x" } }, response: { ok: false } });
    renderLink("BCDF-GHJK");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That code is wrong or expired");
  });

  it("keeps Continue off until the code is complete", () => {
    renderLink("BCD");
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
  });
});
