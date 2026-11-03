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
  await expect(page.getByRole("region", { name: "More like Sousou no Frieren" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Fantasy" })).toBeVisible();
  await catalog.getByRole("link", { name: "Anime" }).click();
  await expect(page).toHaveURL(/\/en$/);
});

test("the catalog switch keeps the page the user is on", async ({ page }) => {
  await signIn(page);
  await page.goto("/en/list");
  const catalog = page.getByRole("navigation", { name: "Catalog" });
  await catalog.getByRole("link", { name: "Manga" }).click();
  await expect(page).toHaveURL(/\/en\/manga\/list$/);
  await catalog.getByRole("link", { name: "Anime" }).click();
  await expect(page).toHaveURL(/\/en\/list$/);
  await page.goto("/en/manga/browse?row=manhwa");
  await catalog.getByRole("link", { name: "Anime" }).click();
  await expect(page).toHaveURL(/\/en\/browse$/);
});

test("browses manga by genre", async ({ page }) => {
  await signIn(page);
  await page.goto("/en/manga/browse");
  const genres = page.getByRole("navigation", { name: "Genres" });
  await expect(page.getByRole("link", { name: /Chainsaw Man/ })).toBeVisible();
  await genres.getByRole("link", { name: "Fantasy" }).click();
  await expect(page).toHaveURL(/genre=10$/);
  await expect(page.getByRole("link", { name: /Sousou no Frieren/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /Chainsaw Man/ })).toHaveCount(0);
  // The genre stays while the ranking changes, and the ranking while the genre is cleared.
  await page.getByRole("navigation", { name: "Rankings" }).getByRole("link", { name: "Manhwa" }).click();
  await expect(page).toHaveURL(/row=manhwa&genre=10$/);
  await genres.getByRole("link", { name: "All genres" }).click();
  await expect(page).toHaveURL(/manga\/browse\?row=manhwa$/);
});

test("splits a long series into ranges, opening the one with the next chapter", async ({ page }) => {
  await signIn(page);
  await page.goto("/en/manga/4");
  const chapters = page.getByRole("region", { name: "Chapters" });
  const ranges = chapters.getByRole("group", { name: "Chapters shown" });
  await expect(ranges.getByRole("button")).toHaveCount(3);
  await expect(ranges.getByRole("button", { name: "101–200" })).toHaveAttribute("aria-pressed", "true");
  await expect(chapters.getByRole("link")).toHaveCount(100);
  await ranges.getByRole("button", { name: "201–250" }).click();
  await expect(chapters.getByRole("link")).toHaveCount(50);
  await expect(chapters.getByRole("link", { name: /Ch\. 250/ })).toBeVisible();
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
  const bars = page.getByRole("group", { name: "Reader controls" });
  await expect(bars.getByText("2 / 4")).toBeVisible();
  await expect(page.getByRole("img", { name: "Page 2" })).toBeVisible();
  // Manga reads right to left: the left arrow key goes forward.
  await page.keyboard.press("ArrowLeft");
  await expect(bars.getByText("3 / 4")).toBeVisible();
  await page.keyboard.press("End");
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByRole("heading", { name: "End of the chapter" })).toBeVisible();
  await page.getByRole("link", { name: "Next: Ch. 3" }).click();
  await expect(page).toHaveURL(/\/read\/stub\/1\/c3/);
  await expect(bars.getByText("1 / 4")).toBeVisible();

  await page.getByRole("button", { name: "Strip" }).click();
  await expect(page.getByRole("img", { name: "Page 4" })).toBeAttached();
});

test("shows a title no source has", async ({ page }) => {
  await signIn(page);
  await page.goto("/en/manga/3");
  await expect(page.getByText("Not available here", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Chapters" })).toHaveCount(0);
});

/** A finger gesture on the reader, as the browser reports it. */
async function touch(page: import("@playwright/test").Page, steps: { type: "touchstart" | "touchmove" | "touchend"; points: [number, number][] }[]) {
  await page.evaluate((steps) => {
    const el = document.querySelector("[data-mode='page'] [role='presentation']")!;
    for (const { type, points } of steps) {
      const touches = points.map(([x, y], i) => new Touch({ identifier: i, target: el, clientX: x, clientY: y }));
      el.dispatchEvent(new TouchEvent(type, { touches: type === "touchend" ? [] : touches, changedTouches: touches, bubbles: true, cancelable: true }));
    }
  }, steps);
}

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("turns pages with a swipe and zooms with two fingers", async ({ page }) => {
    await signIn(page);
    await page.goto("/en/read/stub/1/c1?lang=en");
    const bars = page.getByRole("group", { name: "Reader controls" });
    await expect(bars.getByText("1 / 4")).toBeVisible();
    // A finger moving right reveals the page on the left: the next one, reading right to left.
    await touch(page, [
      { type: "touchstart", points: [[100, 400]] },
      { type: "touchmove", points: [[160, 402]] },
      { type: "touchmove", points: [[260, 404]] },
      { type: "touchend", points: [[260, 404]] },
    ]);
    await expect(bars.getByText("2 / 4")).toBeVisible();

    await touch(page, [
      { type: "touchstart", points: [[150, 400], [250, 400]] },
      { type: "touchmove", points: [[100, 400], [300, 400]] },
      { type: "touchmove", points: [[50, 400], [350, 400]] },
      { type: "touchend", points: [[50, 400], [350, 400]] },
    ]);
    const view = page.locator("[data-mode='page'] [role='presentation']");
    await expect(view).toHaveAttribute("data-zoomed", "true");
    // Zoomed, a drag pans instead of turning the page.
    await touch(page, [
      { type: "touchstart", points: [[100, 400]] },
      { type: "touchmove", points: [[300, 400]] },
      { type: "touchend", points: [[300, 400]] },
    ]);
    await expect(bars.getByText("2 / 4")).toBeVisible();
    // A double tap zooms back out.
    await touch(page, [
      { type: "touchstart", points: [[195, 420]] },
      { type: "touchend", points: [[195, 420]] },
      { type: "touchstart", points: [[195, 420]] },
      { type: "touchend", points: [[195, 420]] },
    ]);
    await expect(view).not.toHaveAttribute("data-zoomed", "true");
  });
});
