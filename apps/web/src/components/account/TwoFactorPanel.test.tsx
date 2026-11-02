import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderAccount } from "@/test/account-intl";

import { TwoFactorPanel } from "./TwoFactorPanel";

vi.mock("@/i18n/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }), usePathname: () => "/settings" }));

const client = vi.hoisted(() => ({ GET: vi.fn(), PATCH: vi.fn(), POST: vi.fn(), DELETE: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: client }));

afterEach(() => {
  for (const fn of Object.values(client)) fn.mockReset();
});

const ok = (data?: unknown) => ({ data, response: { ok: true, status: 200 } });

describe("TwoFactorPanel", () => {
  it("walks through setup and shows the backup codes once", async () => {
    client.POST.mockResolvedValueOnce(ok({ secret: "ABCDEFGHIJKLMNOP", otpauth_uri: "otpauth://totp/MoonRoom:kafka?secret=ABCDEFGHIJKLMNOP" })).mockResolvedValueOnce(
      ok({ backup_codes: ["aaaaa-bbbbb", "ccccc-ddddd"] }),
    );
    renderAccount(<TwoFactorPanel status={{ enabled: false, backup_codes_left: 0 }} />);

    fireEvent.click(screen.getByRole("button", { name: "Set up" }));
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "password123" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(await screen.findByTestId("totp-secret")).toHaveTextContent("ABCD EFGH IJKL MNOP");
    expect(client.POST).toHaveBeenCalledWith("/me/2fa/setup", { body: { password: "password123" } });

    fireEvent.change(screen.getByLabelText("6-digit code"), { target: { value: "123 456" } });
    fireEvent.click(screen.getByRole("button", { name: "Turn on" }));

    expect(await screen.findByText("aaaaa-bbbbb")).toBeInTheDocument();
    expect(client.POST).toHaveBeenLastCalledWith("/me/2fa/enable", { body: { code: "123 456" } });
    fireEvent.click(screen.getByRole("button", { name: "I saved them" }));
    expect(screen.getByText("On")).toBeInTheDocument();
    expect(screen.queryByText("aaaaa-bbbbb")).not.toBeInTheDocument();
  });

  it("shows the translated error for a wrong code", async () => {
    client.POST.mockResolvedValueOnce(ok({ secret: "ABCDEFGHIJKLMNOP", otpauth_uri: "otpauth://totp/x?secret=A" })).mockResolvedValueOnce({
      error: { error: { code: "invalid_code", message: "x" } },
      response: { ok: false, status: 400 },
    });
    renderAccount(<TwoFactorPanel status={{ enabled: false, backup_codes_left: 0 }} />);
    fireEvent.click(screen.getByRole("button", { name: "Set up" }));
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "p" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByTestId("totp-secret");
    fireEvent.change(screen.getByLabelText("6-digit code"), { target: { value: "000000" } });
    fireEvent.click(screen.getByRole("button", { name: "Turn on" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That code is wrong or already used.");
  });

  it("turns it off with the password and a code", async () => {
    client.POST.mockResolvedValueOnce({ response: { ok: true, status: 204 } });
    renderAccount(<TwoFactorPanel status={{ enabled: true, backup_codes_left: 7 }} />);
    expect(screen.getByText("7 backup codes left")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Turn off" }));
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "password123" } });
    fireEvent.change(screen.getByLabelText("Code or backup code"), { target: { value: "123456" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Turn off" })[0]);
    await waitFor(() => expect(client.POST).toHaveBeenCalledWith("/me/2fa/disable", { body: { password: "password123", code: "123456" } }));
    expect(await screen.findByRole("button", { name: "Set up" })).toBeInTheDocument();
  });
});
