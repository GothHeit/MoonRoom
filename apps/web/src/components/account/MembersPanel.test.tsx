import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderAccount } from "@/test/account-intl";

import { MembersPanel } from "./MembersPanel";

vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/members",
}));

const client = vi.hoisted(() => ({ GET: vi.fn(), PATCH: vi.fn(), POST: vi.fn(), DELETE: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: client }));

const members = [
  { id: "me", username: "owner", locale: "en", is_admin: true, two_factor: false, created_at: "2026-10-01T00:00:00Z" },
  { id: "f1", username: "friend", locale: "pt", is_admin: false, two_factor: true, created_at: "2026-11-01T00:00:00Z" },
];

afterEach(() => {
  for (const fn of Object.values(client)) fn.mockReset();
  vi.unstubAllGlobals();
});

describe("MembersPanel", () => {
  it("makes a reset link in the friend's language with the token after the #", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    client.POST.mockResolvedValue({
      data: { token: "abc_DEF-1", locale: "pt", expires_at: "2027-01-01T00:00:00Z" },
      response: { ok: true },
    });
    renderAccount(<MembersPanel members={members} meId="me" />);
    fireEvent.click(screen.getAllByRole("button", { name: "Reset password" })[1]);
    fireEvent.change(screen.getByLabelText("Link valid for"), { target: { value: "24" } });
    fireEvent.click(screen.getByRole("button", { name: "Make link" }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(client.POST).toHaveBeenCalledWith("/admin/users/{user_id}/password-reset", {
      params: { path: { user_id: "f1" } },
      body: { hours_valid: 24 },
    });
    expect(writeText).toHaveBeenCalledWith(expect.stringMatching(/\/pt\/reset-password#abc_DEF-1$/));
    expect(screen.getByText(/two-factor login/)).toBeInTheDocument();
  });

  it("shows an error toast when the link can't be made", async () => {
    client.POST.mockResolvedValue({ error: { error: { code: "user_not_found", message: "x" } }, response: { ok: false } });
    renderAccount(<MembersPanel members={members} meId="me" />);
    fireEvent.click(screen.getAllByRole("button", { name: "Reset password" })[1]);
    fireEvent.click(screen.getByRole("button", { name: "Make link" }));
    expect(await screen.findByText("No one with that name.")).toBeInTheDocument();
  });
});
