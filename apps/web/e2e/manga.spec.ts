import { expect, test } from "@playwright/test";

import { signIn } from "./helpers";

// Reading in one test moves the saved progress: start each from the same place.
test.beforeEach(async ({ request }) => {
  await request.post("http://localhost:4010/manga/__reset");
});

test("switches to the manga catalog and back", async ({ page }) => {
  await signIn(page);
  const catalog = page.getByRole("navigation", { name: "Catalog" });
  await catalog.getByRole("link", { name: "Manga" }).click();
  await expect(page).toHaveURL(/\/en\/manga$/);
  await expect(page.getByRole("heading", { level: 1, name: "Manga" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Continue reading" }).getByRole("link", { name: /Sousou no Frieren.*Ch\. 2/ })).toBeVisible();
  await expect(page.getByRole("region", { name: "Top rated manga" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Main navigation" }).first().getByRole("link", { name: "Browse" })).toHaveAttribute("href", "/en/manga/browse");
  await catalog.getByRole("link", { name: "Anime" }).click();
  await expect(page).toHaveURL(/\/en$/);
});

test("shows a title with its chapters and opens the reader", async ({ page }) => {
  await signIn(page);
  await page.goto("/en/manga/1");
  await expect(page.getByRole("heading", { level: 1, name: "Sousou no Frieren" })).toBeVisible();
  await expect(page.getByText("Read here")).toBeVisible();
  await expect(page.getByText("Manga · 2020 · Ongoing")).toBeVisible();
  await expect(page.getByRole("link", { name: "Continue · Ch. 2" })).toHaveAttribute("href", "/en/read/stub/1/c2?lang=en");
  const chapters = page.getByRole("region", { name: "Chapters" });
  await expect(chapters.getByRole("link")).toHaveCount(3);
  await expect(chapters.getByRole("link", { name: /Ch\. 2.*Page 2 of 4/ })).toBeVisible();

  await chapters.getByRole("combobox", { name: "Language" }).selectOption("pt-br");
  await expect(page).toHaveURL(/lang=pt-br/);
  await expect(chapters.getByRole("link", { name: /O fim da jornada/ })).toBeVisible();

  await page.goto("/en/read/stub/1/c2?lang=en");
  await expect(page.getByText("2 / 4")).toBeVisible();
  await expect(page.getByRole("img", { name: "Page 2" })).toBeVisible();
  // Manga reads right to left: the left arrow key goes forward.
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByText("3 / 4")).toBeVisible();
  await page.keyboard.press("End");
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByRole("heading", { name: "End of the chapter" })).toBeVisible();
  await page.getByRole("link", { name: "Next: Ch. 3" }).click();
  await expect(page).toHaveURL(/\/read\/stub\/1\/c3/);
  await expect(page.getByText("1 / 4")).toBeVisible();

  await page.getByRole("button", { name: "Strip" }).click();
  await expect(page.getByRole("img", { name: "Page 4" })).toBeAttached();
});

test("shows a title no source has", async ({ page }) => {
  await signIn(page);
  await page.goto("/en/manga/3");
  await expect(page.getByText("Not available here", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Chapters" })).toHaveCount(0);
});
