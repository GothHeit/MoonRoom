import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import messages from "../../../messages/en/install.json";
import { InstallHint } from "./InstallHint";

let path = "/";
vi.mock("@/i18n/navigation", () => ({ usePathname: () => path }));

const IOS_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1";

function setup() {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <InstallHint />
    </NextIntlClientProvider>,
  );
}

describe("InstallHint", () => {
  beforeEach(() => {
    localStorage.clear();
    path = "/";
    vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("shows the Add to Home Screen steps in iOS Safari and stays hidden once dismissed", async () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(IOS_UA);
    setup();
    expect(screen.getByText(/Add to Home Screen/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText(/Add to Home Screen/)).not.toBeInTheDocument();
    expect(localStorage.getItem("moonroom.installHint.dismissed")).toBe("1");
  });

  it("renders nothing on a desktop browser", () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (X11; Linux x86_64) Chrome/120");
    setup();
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
  });

  it("stays off title pages, so it never covers Play", () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(IOS_UA);
    path = "/anime/1";
    setup();
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
  });

  it("is not shown again after it was seen once", () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(IOS_UA);
    setup();
    expect(localStorage.getItem("moonroom.installHint.dismissed")).toBe("1");
    document.body.innerHTML = "";
    setup();
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
  });

  it("is not shown inside the installed app", () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(IOS_UA);
    vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
    setup();
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
  });
});
