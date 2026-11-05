import { expect, test, type Page } from "@playwright/test";

import { signIn } from "./helpers";

const API = "http://localhost:4010";

test.use({ viewport: { width: 1920, height: 1080 } });

type Saved = { anime_id: number; episode: number; position_seconds: number };

// Each test plays its own title, so the saved progress of one never moves another's start.
async function saved(page: Page, animeId: number, episode: number) {
  const all: Saved[] = await (await page.request.get(`${API}/__progress`)).json();
  return all.find((p) => p.anime_id === animeId && p.episode === episode);
}

const video = (page: Page) => page.locator("video");
const currentTime = (page: Page) => video(page).evaluate((v: HTMLVideoElement) => v.currentTime);
const paused = (page: Page) => video(page).evaluate((v: HTMLVideoElement) => v.paused);
const focusedName = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return el?.getAttribute("aria-label") ?? el?.textContent?.trim() ?? "";
  });

/** A remote press: the spatial navigation ignores presses closer together than a held key's. */
async function press(page: Page, key: string) {
  await page.keyboard.press(key);
  await page.waitForTimeout(150);
}

/** Moves right along the control row until `name` has focus. */
async function focusControl(page: Page, name: string) {
  await press(page, "ArrowDown");
  for (let i = 0; i < 8 && (await focusedName(page)) !== name; i++) await press(page, "ArrowRight");
  expect(await focusedName(page)).toBe(name);
}

test("plays from the title page in TV mode, pauses with OK, goes back and resumes", async ({ page }) => {
  await signIn(page);
  await page.goto("/en/tv/anime/12");
  await expect(page.getByRole("link", { name: "Play episode 1" })).toBeFocused();
  await press(page, "Enter");
  await expect(page).toHaveURL(/\/en\/tv\/watch\/stub\/12\/1$/);
  // Past the few seconds a resume ignores, so the reload below starts where it paused.
  await expect.poll(() => currentTime(page), { timeout: 15_000 }).toBeGreaterThan(6);

  // Focus starts on the timeline, where OK plays or pauses.
  await press(page, "Enter");
  await expect.poll(() => paused(page)).toBe(true);
  const at = await currentTime(page);
  await expect.poll(async () => (await saved(page, 12, 1))?.position_seconds).toBeCloseTo(at, 0);

  await press(page, "Escape");
  await expect(page).toHaveURL(/\/en\/tv\/anime\/12$/);

  await page.goto("/en/tv/watch/stub/12/1");
  await expect.poll(() => currentTime(page)).toBeGreaterThanOrEqual(Math.floor(at));
});

test("seeks with the arrows once the presses stop", async ({ page }) => {
  await signIn(page);
  await page.goto("/en/tv/watch/stub/13/1");
  await expect.poll(() => video(page).evaluate((v: HTMLVideoElement) => v.duration)).toBeGreaterThan(30);
  await expect.poll(() => paused(page)).toBe(false);
  await press(page, "Enter");
  await expect.poll(() => paused(page)).toBe(true);
  const from = await currentTime(page);
  await press(page, "ArrowRight");
  await press(page, "ArrowRight");
  await expect(page.getByRole("slider", { name: "Timeline" })).toBeVisible();
  await expect.poll(() => currentTime(page)).toBeCloseTo(from + 20, 0);
});

test("picks subtitles from the side panel and Back returns to the button", async ({ page }) => {
  await signIn(page);
  await page.goto("/en/tv/watch/stub/14/1");
  await expect(video(page).locator("track")).toHaveCount(2);
  await focusControl(page, "Subtitles");
  await press(page, "Enter");
  const panel = page.getByRole("dialog", { name: "Subtitles" });
  await expect(panel).toBeVisible();
  // Focus starts on the current choice: Portuguese, then up past English to Off.
  await expect(panel.getByRole("menuitemradio", { name: /Brazilian Portuguese/ })).toBeFocused();
  await press(page, "ArrowUp");
  await press(page, "ArrowUp");
  await press(page, "Enter");
  await expect(panel.getByRole("menuitemradio", { name: "Off" })).toHaveAttribute("aria-checked", "true");
  await press(page, "Escape");
  await expect(panel).toBeHidden();
  await expect(page).toHaveURL(/\/en\/tv\/watch\/stub\/14\/1$/);
  expect(await focusedName(page)).toBe("Subtitles");
});

test("offers the next episode at the end and opens it in TV mode", async ({ page }) => {
  await signIn(page);
  await page.goto("/en/tv/watch/stub/15/1");
  await expect.poll(() => video(page).evaluate((v: HTMLVideoElement) => v.duration)).toBeGreaterThan(30);
  await video(page).evaluate((v: HTMLVideoElement) => {
    v.currentTime = v.duration - 0.3;
    return v.play();
  });
  await expect(page.getByText(/Starts in \d+ seconds?/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Play now" })).toBeFocused();
  await press(page, "Enter");
  await expect(page).toHaveURL(/\/en\/tv\/watch\/stub\/15\/2$/);
});

test("shows the episode in Portuguese", async ({ page }) => {
  await signIn(page, "pt");
  await page.goto("/pt/tv/watch/stub/16/1");
  await expect(page.getByText("Episódio 1", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Legendas" })).toBeVisible();
});
