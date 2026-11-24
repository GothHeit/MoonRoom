import { devices, expect, test } from "@playwright/test";

import { signIn } from "./helpers";

// Run in the installed Chromium rather than WebKit.
const iphone = { ...devices["iPhone 13"], defaultBrowserType: undefined };
test.use(iphone);

test("the app can be added to the Home Screen", async ({ page, request }) => {
  await page.goto("/en/login");
  await expect(page.locator('meta[name="viewport"]')).toHaveAttribute("content", /viewport-fit=cover/);
  await expect(page.locator('meta[name="apple-mobile-web-app-status-bar-style"]')).toHaveCount(1);
  expect(await page.locator('link[rel="apple-touch-startup-image"]').count()).toBeGreaterThan(5);

  const manifest = await (await request.get("/manifest.webmanifest")).json();
  expect(manifest.display).toBe("standalone");
  for (const icon of manifest.icons) expect((await request.get(icon.src)).ok()).toBe(true);
});

test("main pages do not scroll sideways on a phone", async ({ page }) => {
  await signIn(page, "en");
  for (const path of ["/en", "/en/browse", "/en/list", "/en/settings", "/en/anime/1"]) {
    await page.goto(path);
    await expect(page.locator("main")).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, path).toBe(0);
  }
});

test("search works on a phone from the Search tab", async ({ page }) => {
  await signIn(page, "en");
  await page.getByRole("link", { name: "Search" }).click();
  const box = page.getByRole("searchbox", { name: "Search" });
  await box.tap();
  await box.fill("dungeon");
  await box.press("Enter");
  await expect(page).toHaveURL(/\/en\/search\?q=dungeon$/);
  await expect(page.getByRole("link", { name: /Dungeon Meshi/ })).toBeVisible();
});

test("the account menu is a bottom sheet on a phone", async ({ page }) => {
  await signIn(page, "en");
  await page.getByRole("button", { name: "Account menu" }).tap();
  const sheet = page.getByRole("dialog", { name: "Account menu" });
  await expect(sheet.getByRole("menuitem", { name: "Sign out" })).toBeInViewport({ ratio: 1 });
  // Pinned to the bottom edge, full width.
  await expect.poll(async () => {
    const box = await sheet.boundingBox();
    const view = page.viewportSize()!;
    return box && Math.round(box.y + box.height) === view.height && Math.round(box.width) === view.width;
  }).toBe(true);

  await page.getByTestId("sheet-scrim").tap({ position: { x: 20, y: 20 } });
  await expect(sheet).toHaveCount(0);

  await page.getByRole("button", { name: "Account menu" }).tap();
  await page.getByRole("menuitem", { name: "Settings" }).tap();
  await expect(page).toHaveURL(/\/en\/settings$/);
  await expect(sheet).toHaveCount(0);
});

test("search with nothing typed offers genres and Browse", async ({ page }) => {
  await signIn(page, "en");
  await page.goto("/en/search");
  await page.getByRole("link", { name: "Fantasy" }).tap();
  await expect(page).toHaveURL(/\/en\/browse\?genre=2$/);
});
