import { expect, test } from "@playwright/test";

import { signIn } from "./helpers";

test("the owner makes a reset link and a friend uses it once", async ({ page, context, baseURL }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await signIn(page, "en", "owner");
  await page.goto("/en/members");
  await expect(page.getByRole("heading", { name: "Members" })).toBeVisible();
  const friend = page.getByRole("listitem").filter({ hasText: "friend" });
  await friend.getByRole("button", { name: "Reset password" }).click();
  await friend.getByRole("button", { name: "Make link" }).click();
  const link = friend.getByRole("textbox");
  await expect(link).toHaveValue(`${baseURL}/pt/reset-password#good-token`);
  // Never visible to the browser's referrer: the token is only in the fragment.
  expect(new URL(await link.inputValue()).search).toBe("");

  const friendPage = await context.browser()!.newPage();
  await friendPage.goto(`${baseURL}/pt/reset-password#good-token`);
  await expect(friendPage.getByText("Escolha uma nova senha para friend.")).toBeVisible();
  await friendPage.getByLabel("Nova senha", { exact: true }).fill("brand-new-pass");
  await friendPage.getByLabel("Repita a nova senha").fill("brand-new-pass");
  await friendPage.getByRole("button", { name: "Salvar senha" }).click();
  await expect(friendPage.getByText("Senha alterada")).toBeVisible();

  // Opening the same link again later is a fresh page load.
  await friendPage.goto("about:blank");
  await friendPage.goto(`${baseURL}/pt/reset-password#good-token`);
  await expect(friendPage.getByText("Este link não funciona")).toBeVisible();
});

test("a page without a token says the link is dead", async ({ page }) => {
  await page.goto("/en/reset-password");
  await expect(page.getByText("This link doesn't work")).toBeVisible();
});

test("members is hidden from non-admins", async ({ page }) => {
  await signIn(page);
  const res = await page.goto("/en/members");
  expect(res?.status()).toBe(404);
});
