import { expect, test, type Page } from "@playwright/test";

import { signIn } from "./helpers";

const API = "http://localhost:4010";

test.use({ viewport: { width: 1920, height: 1080 } });

async function press(page: Page, key: string) {
  await page.keyboard.press(key);
  await page.waitForTimeout(150);
}

/** Opens the TV app the way a TV does: a full load of its start address. */
async function openApp(page: Page) {
  await page.goto("/en/tv");
}

/** Signs `username` in on this browser, then gives the TV a second account through the code flow. */
async function twoAccounts(page: Page) {
  await signIn(page);
  await openApp(page);
  await expect(page).toHaveURL(/\/en\/tv\/accounts$/);
  await page.getByRole("button", { name: "Add account" }).click();
  await expect(page).toHaveURL(/\/en\/tv\/accounts\/add$/);
  await expect(page.getByLabel("Sign-in code")).toHaveText("BCDF-GHJK");
  await page.request.get(`${API}/__approve_device?user=linked`);
  await expect(page).toHaveURL(/\/en\/tv$/, { timeout: 15_000 });
}

test("asks who is watching when the app opens, even with one account", async ({ page }) => {
  await signIn(page);
  await openApp(page);
  await expect(page).toHaveURL(/\/en\/tv\/accounts$/);
  await expect(page.getByRole("heading", { name: "Who’s watching?" })).toBeVisible();
  await expect(page.getByRole("button", { name: "kafka" })).toBeFocused();
  await press(page, "ArrowRight");
  await expect(page.getByRole("button", { name: "Add account" })).toBeFocused();
  await press(page, "ArrowLeft");
  await press(page, "Enter");
  await expect(page).toHaveURL(/\/en\/tv$/);
  await expect(page.getByRole("link", { name: "Home" })).toBeVisible();
});

test("adds a second account with a code, then switches between the two", async ({ page }) => {
  await twoAccounts(page);
  // The new account is the one on screen.
  await expect(page.getByText("linked").first()).toBeVisible();

  await openApp(page);
  await expect(page).toHaveURL(/\/en\/tv\/accounts$/);
  // Listed by name; the account in use is focused first, and both are there with the plus.
  const names = await page.getByRole("button").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
  expect(names).toEqual(["kafka", "linked", "Add account"]);
  await page.getByRole("button", { name: "kafka" }).click();
  await expect(page).toHaveURL(/\/en\/tv$/);
  await expect(page.getByText("kafka").first()).toBeVisible();

  // Switching again, from Settings this time, keeps both.
  await page.goto("/en/tv/settings");
  await page.getByRole("button", { name: "Switch account" }).click();
  await expect(page).toHaveURL(/\/en\/tv\/accounts\?back=1$/);
  await page.getByRole("button", { name: "linked" }).click();
  await expect(page).toHaveURL(/\/en\/tv$/);
  await expect(page.getByText("linked").first()).toBeVisible();
});

test("removing an account signs it out and leaves the other one", async ({ page }) => {
  await twoAccounts(page);
  await page.goto("/en/tv/settings");
  await page.getByRole("button", { name: "Remove from this TV" }).click();
  await expect(page).toHaveURL(/\/en\/tv\/accounts$/);
  await expect(page.getByRole("button", { name: "kafka" })).toBeVisible();
  await expect(page.getByRole("button", { name: "linked" })).toHaveCount(0);
  await page.getByRole("button", { name: "kafka" }).click();
  await expect(page).toHaveURL(/\/en\/tv$/);

  // The last account removed: back to the sign-in code.
  await page.goto("/en/tv/settings");
  await page.getByRole("button", { name: "Remove from this TV" }).click();
  await expect(page).toHaveURL(/\/en\/tv\/login$/);
});

test("the picker works in Portuguese", async ({ page }) => {
  await signIn(page, "pt");
  await page.goto("/pt/tv");
  await expect(page).toHaveURL(/\/pt\/tv\/accounts$/);
  await expect(page.getByRole("heading", { name: "Quem está assistindo?" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Adicionar conta" })).toBeVisible();
});
