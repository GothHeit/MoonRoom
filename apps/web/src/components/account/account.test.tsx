import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderAccount } from "@/test/account-intl";

import { inviteStatus, InvitesPanel } from "./InvitesPanel";
import { MalSection } from "./MalSection";
import { PreferencesForm } from "./PreferencesForm";
import { SessionsPanel, type LoginSession } from "./SessionsPanel";

const replace = vi.fn();
const refresh = vi.fn();
vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ replace, refresh }),
  usePathname: () => "/settings",
}));

// openapi-fetch keeps the fetch it finds when the client is created, so stubbing fetch later has no effect.
const client = vi.hoisted(() => ({ GET: vi.fn(), PATCH: vi.fn(), POST: vi.fn(), DELETE: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: client }));

const ok = (data: unknown = {}) => ({ data, response: { ok: true } });
const failed = { error: { error: { code: "unknown", message: "x" } }, response: { ok: false } };

afterEach(() => {
  for (const fn of Object.values(client)) fn.mockReset();
  vi.unstubAllGlobals();
  replace.mockClear();
  refresh.mockClear();
});


describe("PreferencesForm", () => {
  it("saves the +18 switch and refreshes", async () => {
    client.PATCH.mockResolvedValue(ok());
    renderAccount(<PreferencesForm showNsfw shareActivity mangaLang={null} />);
    const toggle = screen.getByRole("switch", { name: "Show +18 titles" });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "false");
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(client.PATCH).toHaveBeenCalledWith("/me", { body: { show_nsfw: false } });
  });

  it("puts the switch back when saving fails", async () => {
    client.PATCH.mockResolvedValue(failed);
    renderAccount(<PreferencesForm showNsfw shareActivity mangaLang={null} />);
    const toggle = screen.getByRole("switch", { name: "Show +18 titles" });
    fireEvent.click(toggle);
    expect(await screen.findByText("Couldn't save your settings.")).toBeInTheDocument();
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("saves the language, then moves to that language's page", async () => {
    client.PATCH.mockResolvedValue(ok());
    renderAccount(<PreferencesForm showNsfw shareActivity mangaLang={null} />);
    fireEvent.change(screen.getByLabelText(/Language/), { target: { value: "pt" } });
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/settings", { locale: "pt" }));
  });

  it("saves the manga language", async () => {
    client.PATCH.mockResolvedValue(ok());
    renderAccount(<PreferencesForm showNsfw shareActivity mangaLang={null} />);
    fireEvent.change(screen.getByLabelText(/Manga language/), { target: { value: "pt-br" } });
    await waitFor(() => expect(client.PATCH).toHaveBeenCalledWith("/me", { body: { manga_lang: "pt-br" } }));
  });
});

describe("SessionsPanel", () => {
  const session = (id: string, day: number, current = false): LoginSession => ({
    id,
    user_agent: null,
    ip: `10.0.0.${day}`,
    started_at: "2026-01-01T00:00:00Z",
    last_active_at: `2026-01-${String(day).padStart(2, "0")}T00:00:00Z`,
    current,
  });

  it("shows this device and the four used most recently until asked for all", () => {
    const sessions = [session("old", 1), session("mine", 2, true), ...[3, 4, 5, 6, 7].map((d) => session(`s${d}`, d))];
    renderAccount(<SessionsPanel sessions={sessions} />);
    const ips = () => screen.getAllByTestId("session").map((row) => /10\.0\.0\.\d+/.exec(row.textContent ?? "")?.[0]);
    expect(ips()).toEqual(["10.0.0.2", "10.0.0.7", "10.0.0.6", "10.0.0.5", "10.0.0.4"]);

    fireEvent.click(screen.getByRole("button", { name: "Show all (7)" }));
    expect(ips()).toHaveLength(7);
    fireEvent.click(screen.getByRole("button", { name: "Show recent only" }));
    expect(ips()).toHaveLength(5);
  });

  it("has no show-all button for a short list", () => {
    renderAccount(<SessionsPanel sessions={[session("mine", 2, true), session("phone", 1)]} />);
    expect(screen.queryByRole("button", { name: /Show all/ })).not.toBeInTheDocument();
  });
});

describe("MalSection", () => {
  it("offers to link when not linked and sends the user to MAL", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    client.GET.mockResolvedValue(ok({ auth_url: "https://myanimelist.net/auth" }));
    renderAccount(<MalSection status={{ connected: false }} />);
    expect(screen.getByText("Not linked")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Link MyAnimeList" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://myanimelist.net/auth"));
  });

  it("shows the linked account and unlinks after confirming", async () => {
    client.DELETE.mockResolvedValue(ok(undefined));
    renderAccount(
      <MalSection status={{ connected: true, mal_username: "kafka", statistics: { num_items_watching: 3 } }} />,
    );
    expect(screen.getByText("Linked as kafka")).toBeInTheDocument();
    expect(screen.getByText("3 watching · 0 completed · 0 plan to watch")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Unlink" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Unlink" }).at(-1)!);
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(client.DELETE).toHaveBeenCalledWith("/me/mal");
  });

  it("reports the callback result once and clears it from the URL", async () => {
    renderAccount(<MalSection status={{ connected: false }} returned="denied" />);
    expect(await screen.findByText("You didn't allow access on MyAnimeList.")).toBeInTheDocument();
    expect(replace).toHaveBeenCalledWith("/settings");
  });
});

describe("InvitesPanel", () => {
  const now = Date.parse("2026-10-26T12:00:00Z");

  it("derives the invite state", () => {
    expect(inviteStatus({ code: "a", used: true, expires_at: "2027-01-01T00:00:00Z" }, now)).toBe("used");
    expect(inviteStatus({ code: "a", used: false, expires_at: "2026-10-01T00:00:00Z" }, now)).toBe("expired");
    expect(inviteStatus({ code: "a", used: false, expires_at: "2026-11-01T00:00:00Z" }, now)).toBe("active");
  });

  it("lists invites, offers copy only for active ones", () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    renderAccount(
      <InvitesPanel
        invites={[
          { code: "ACTIVE1", used: false, expires_at: future },
          { code: "USED1", used: true, expires_at: future },
        ]}
      />,
    );
    expect(screen.getByText("ACTIVE1")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Copy link" })).toHaveLength(1);
  });

  it("creates an invite with the chosen validity and copies the register link", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    client.POST.mockResolvedValue(ok({ code: "NEWCODE", used: false, expires_at: "2027-01-01T00:00:00Z" }));
    renderAccount(<InvitesPanel invites={[]} />);
    expect(screen.getByText("No invites yet.")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Valid for"), { target: { value: "30" } });
    fireEvent.click(screen.getByRole("button", { name: "Create invite" }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(client.POST).toHaveBeenCalledWith("/invites", { body: { days_valid: 30 } });
    expect(writeText).toHaveBeenCalledWith(expect.stringMatching(/\/en\/register\?invite=NEWCODE$/));
  });
});
