import { expect, test } from "@playwright/test";

import { signIn } from "./helpers";

test("pages carry the content security policy and break none of its rules", async ({ page }) => {
  const violations: string[] = [];
  page.on("console", (message) => {
    if (/Content Security Policy/i.test(message.text())) violations.push(message.text());
  });

  const login = await page.goto("/en/login");
  const policy = login!.headers()["content-security-policy"];
  expect(policy).toContain("default-src 'self'");
  expect(policy).toContain("frame-ancestors 'none'");

  await signIn(page);
  await page.goto("/en/anime/1");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

  // The player is the page with the most moving parts: hls.js, workers, WebAssembly subtitles.
  await page.goto("/en/watch/stub/7/1");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: /^Subtitles/ }).click();
  await page.getByRole("radio", { name: "Brazilian Portuguese" }).click();
  await page.getByRole("button", { name: "Close settings" }).click();
  await expect(page.getByTestId("ass-subtitles").locator("canvas")).toHaveCount(1);
  await page.waitForTimeout(1000);

  expect(violations).toEqual([]);
});
