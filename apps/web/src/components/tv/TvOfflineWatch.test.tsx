import { act, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import messages from "../../../messages/en/tv.json";
import { TvOfflineWatch } from "./TvOfflineWatch";

function show() {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <TvOfflineWatch />
    </NextIntlClientProvider>,
  );
}

describe("TvOfflineWatch", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("shows nothing while the site answers", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    show();
    await act(() => vi.advanceTimersByTimeAsync(20_000));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("covers the screen once the site stops answering, then the long text after a minute", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    show();
    await act(() => vi.advanceTimersByTimeAsync(9_000));
    expect(screen.getByRole("status").textContent).toContain("Reconnecting");
    await act(() => vi.advanceTimersByTimeAsync(70_000));
    expect(screen.getByRole("status").textContent).toContain(
      "MoonRoom is offline",
    );
  });
});
