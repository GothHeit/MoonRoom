import { expect, test } from "@playwright/test";

import { signIn } from "./helpers";

test("the profile shows manga stats and what they are reading", async ({ page }) => {
  await signIn(page);
  await page.goto("/en/u/00000000-0000-4000-8000-000000000001");
  const manga = page.getByRole("region", { name: "Manga" });
  await expect(manga.getByText("Chapters read")).toBeVisible();
  await expect(manga.getByText("41")).toBeVisible();
  await expect(manga.getByRole("list", { name: "Favorite genres" })).toContainText("Adventure");
  await expect(manga.getByRole("region", { name: "Reading" }).getByRole("link", { name: /Sousou no Frieren.*Ch\. 12/ })).toHaveAttribute("href", "/en/manga/1");
  await expect(manga.getByRole("region", { name: "Recently finished" }).getByRole("link", { name: /Vagabond.*Ch\. 9/ })).toBeVisible();
});
