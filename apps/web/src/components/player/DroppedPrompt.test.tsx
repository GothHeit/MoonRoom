import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";

import en from "../../../messages/en/player.json";
import { DroppedPrompt } from "./DroppedPrompt";

function setup() {
  const onAccept = vi.fn();
  const onDismiss = vi.fn();
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      <DroppedPrompt onAccept={onAccept} onDismiss={onDismiss} />
    </NextIntlClientProvider>,
  );
  return { onAccept, onDismiss };
}

describe("DroppedPrompt", () => {
  it("moves the title back to watching", async () => {
    const { onAccept } = setup();
    await userEvent.click(screen.getByRole("button", { name: "Move to Watching" }));
    expect(onAccept).toHaveBeenCalled();
  });

  it("can be dismissed", async () => {
    const { onDismiss } = setup();
    await userEvent.click(screen.getByRole("button", { name: "Keep Dropped" }));
    expect(onDismiss).toHaveBeenCalled();
  });
});
