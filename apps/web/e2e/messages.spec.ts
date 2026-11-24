import { expect, test } from "@playwright/test";

import { signIn } from "./helpers";

const API = "http://localhost:4010";

test.beforeEach(async ({ request }) => {
  await request.get(`${API}/chats/__reset`);
});

test("opens a chat from the icon beside the bell and sends a message", async ({ page }) => {
  await signIn(page);
  const icon = page.getByRole("link", { name: "Messages, 1 unread chat" }).first();
  await expect(icon).toBeVisible();
  await icon.click();
  await expect(page).toHaveURL(/\/en\/messages$/);
  await expect(page.getByRole("heading", { name: "Pick a chat" })).toBeVisible();

  // Newest first; the muted chat says so.
  const rows = page.getByRole("main").getByRole("listitem");
  await expect(rows.nth(0)).toContainText("Saturday anime");
  await expect(rows.nth(0)).toContainText("pondofe: ep 9 was insane");
  await expect(rows.nth(1)).toContainText("You: tell me when you get to the end");
  await expect(rows.nth(2)).toContainText("Muted");

  await rows.nth(1).click();
  await expect(page).toHaveURL(/\/en\/messages\/10000000-0000-4000-8000-000000000001$/);
  const chat = page.getByRole("region", { name: "junior" });
  await expect(chat.getByText("Frieren")).toBeVisible();
  await expect(chat.getByText("Episode 4")).toBeVisible();
  await expect(chat.getByRole("link", { name: "Play" })).toHaveAttribute("href", "/en/continue/1/4");
  await expect(chat.getByText(/· Seen$/)).toBeVisible();

  await chat.getByLabel("Message", { exact: true }).fill("on my way");
  await chat.getByRole("button", { name: "Send" }).click();
  await expect(chat.getByText("on my way")).toHaveCount(1);
  await expect(chat.getByLabel("Message", { exact: true })).toHaveValue("");
});

test("sends a title to a friend and a group from its page", async ({ page }) => {
  await signIn(page);
  await page.goto("/en/anime/1");
  await page.getByRole("button", { name: "Send to a friend" }).click();
  const sheet = page.getByRole("dialog", { name: "Send to a friend" });
  await expect(sheet.getByRole("radio", { name: "Whole title" })).toHaveAttribute("aria-checked", "true");
  await sheet.getByRole("checkbox", { name: "junior" }).click();
  await sheet.getByRole("checkbox", { name: "Saturday anime" }).click();
  await sheet.getByPlaceholder("Add a note (optional)").fill("trust me");
  await sheet.getByRole("button", { name: "Send to 2" }).click();
  await expect(sheet).toBeHidden();
  await expect(page.getByText("Sent.")).toBeVisible();

  await page.goto("/en/messages/10000000-0000-4000-8000-000000000002");
  const chat = page.getByRole("region", { name: "Saturday anime" });
  await expect(chat.getByText("trust me")).toBeVisible();
  await expect(chat.getByText("3 people")).toBeVisible();
});

test("phone: the chat covers the page and goes back to the list", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, "pt");
  await page.goto("/pt/messages/10000000-0000-4000-8000-000000000002");
  const chat = page.getByRole("region", { name: "Saturday anime" });
  await expect(chat.getByText("Capítulo 112")).toBeVisible();
  await expect(chat.getByRole("link", { name: "Ler" })).toBeVisible();
  await chat.getByRole("link", { name: "Voltar para mensagens" }).click();
  await expect(page).toHaveURL(/\/pt\/messages$/);
  await expect(page.getByRole("heading", { name: "Mensagens" })).toBeVisible();
});
