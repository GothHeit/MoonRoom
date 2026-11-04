import { expect, test } from "@playwright/test";

import { signIn } from "./helpers";

test.describe("with a Portuguese browser", () => {
  test.use({ locale: "pt-BR" });

  test("picks Portuguese", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/pt\/login$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Entrar");
    await expect(page.locator("html")).toHaveAttribute("lang", "pt-BR");
  });
});

test("picks English for an English browser", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/en\/login$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Sign in");
});

test("falls back to Portuguese for other languages", async ({ browser }) => {
  const page = await browser.newPage({ locale: "ja-JP" });
  await page.goto("/");
  await expect(page).toHaveURL(/\/pt\/login$/);
  await page.close();
});

test("switches language on the login page and keeps the page", async ({ page }) => {
  await page.goto("/pt/login");
  // The auth layout renders two switchers and shows one per orientation.
  await page.locator('select[aria-label="Idioma"]:visible').selectOption("en");
  await expect(page).toHaveURL(/\/en\/login$/);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
});

test("switches language while signed in", async ({ page }) => {
  await signIn(page, "en");
  await page.getByLabel("Language").selectOption("pt");
  await expect(page).toHaveURL(/\/pt$/);
  await expect(page.getByRole("link", { name: "Início" }).first()).toBeVisible();
});

test("shows a localized not-found page", async ({ page }) => {
  await page.goto("/en/nowhere");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await signIn(page);
  await page.goto("/en/nowhere");
  await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
});
