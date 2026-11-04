import { expect, test, type Page } from "@playwright/test";

import { signIn } from "./helpers";

const API = "http://localhost:4010";

type Saved = { anime_id: number; episode: number; position_seconds: number; completed: boolean };

async function saved(page: Page, episode: number) {
  const all: Saved[] = await (await page.request.get(`${API}/__progress`)).json();
  return all.find((p) => p.anime_id === 4 && p.episode === episode);
}

const video = (page: Page) => page.locator("video");
const currentTime = (page: Page) => video(page).evaluate((v: HTMLVideoElement) => v.currentTime);

test("resumes from the saved position and saves on pause", async ({ page }) => {
  await signIn(page);
  await page.goto("/en/watch/stub/4/2");
  await expect(page.getByText("Episode 2", { exact: true })).toBeVisible();
  await expect.poll(() => currentTime(page)).toBeGreaterThanOrEqual(12);
  await expect.poll(() => video(page).evaluate((v: HTMLVideoElement) => !v.paused)).toBe(true);

  await page.keyboard.press("Space");
  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeVisible();
  const at = await currentTime(page);
  await expect.poll(async () => (await saved(page, 2))?.position_seconds).toBeCloseTo(at, 0);
});

test("offers the next episode at the end and marks the episode watched", async ({ page }) => {
  await signIn(page);
  await page.goto("/en/watch/stub/4/1");
  await expect.poll(() => video(page).evaluate((v: HTMLVideoElement) => v.duration)).toBeGreaterThan(30);
  await video(page).evaluate((v: HTMLVideoElement) => {
    v.currentTime = v.duration - 0.3;
    return v.play();
  });
  await expect(page.getByText(/Episode 2 starts in \d+ seconds?/)).toBeVisible();
  await expect.poll(async () => (await saved(page, 1))?.completed).toBe(true);
  await page.getByRole("button", { name: "Play now" }).click();
  await expect(page).toHaveURL(/\/en\/watch\/stub\/4\/2$/);
});

test("cancels the countdown", async ({ page }) => {
  await signIn(page);
  await page.goto("/en/watch/stub/4/2?t=39");
  await expect(page.getByText(/Episode 3 starts in/)).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByText("Up next: episode 3")).toBeVisible();
  await page.waitForTimeout(1500);
  await expect(page).toHaveURL(/\/watch\/stub\/4\/2\?t=39$/);
});

test("offers subtitles, defaulting to Portuguese, and remembers Off", async ({ page }) => {
  await signIn(page);
  await page.goto("/en/watch/stub/4/1");
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("button", { name: /^Subtitles/ })).toContainText("Brazilian Portuguese");
  await expect(video(page).locator("track")).toHaveCount(2);

  await page.getByRole("button", { name: /^Subtitles/ }).click();
  await page.getByRole("radio", { name: "Off" }).click();
  await page.reload();
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("button", { name: /^Subtitles/ })).toContainText("Off");
});

test("hides the subtitle picker when the episode has no subtitles", async ({ page }) => {
  await signIn(page);
  await page.goto("/en/watch/stub/4/3");
  await expect(page.getByText("Episode 3", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("button", { name: /^Speed|^Playback speed/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Subtitles/ })).toHaveCount(0);
});

test("explains a disabled source", async ({ page }) => {
  await signIn(page);
  await page.goto("/en/watch/off/4/1");
  await expect(page.getByText("Streaming is turned off on this server.")).toBeVisible();
});

test("offers no source switch when the episode has only one version", async ({ page }) => {
  await signIn(page);
  await page.goto("/en/watch/stub/4/2");
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("button", { name: /^Playback speed/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Source/ })).toHaveCount(0);
});

test("switches source at the same spot and remembers it for the title", async ({ page }) => {
  await signIn(page);
  await page.goto("/en/watch/stub/7/1");
  await expect.poll(() => currentTime(page), { timeout: 20_000 }).toBeGreaterThan(2);
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: /^Source/ }).click();
  await page.getByRole("radio", { name: "stub · Dub" }).click();
  await expect(page).toHaveURL(/\/watch\/stub\/7\/1\?lang=dub&t=\d+$/);
  const t = Number(new URL(page.url()).searchParams.get("t"));
  expect(t).toBeGreaterThanOrEqual(2);
  await expect.poll(() => currentTime(page)).toBeGreaterThanOrEqual(t);

  await page.goto("/en/continue/7/1");
  await expect(page).toHaveURL(/\/watch\/stub\/7\/1\?lang=dub$/);
});

test("seeks through the stream route with range requests", async ({ page }) => {
  await signIn(page);
  const res = await page.request.get("/api/stream/video?token=ep-1-sub", { headers: { Range: "bytes=100-199" } });
  expect(res.status()).toBe(206);
  expect(res.headers()["content-range"]).toMatch(/^bytes 100-199\/\d+$/);
  expect((await res.body()).length).toBe(100);
});

test("draws subtitles in the saved style and remembers a new one", async ({ page }) => {
  await signIn(page);
  await page.goto("/en/watch/stub/4/1");
  // An earlier test may have saved "Off".
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: /^Subtitles/ }).click();
  await page.getByRole("radio", { name: "Brazilian Portuguese" }).click();
  await page.getByRole("button", { name: "Close settings" }).click();
  const subtitles = page.getByTestId("subtitles");
  await expect(subtitles).toHaveText("Hello moon");
  await expect(subtitles.locator("span")).toHaveCSS("color", "rgb(255, 255, 255)");

  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: /^Subtitles/ }).click();
  await page.getByRole("button", { name: "Subtitle style" }).click();
  await page.getByRole("radiogroup", { name: "Color" }).getByRole("radio", { name: "Yellow" }).click();
  await expect(subtitles.locator("span")).toHaveCSS("color", "rgb(255, 233, 77)");
  await page.reload();
  await expect(page.getByTestId("subtitles").locator("span")).toHaveCSS("color", "rgb(255, 233, 77)");

  // Put it back for the other tests.
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: /^Subtitles/ }).click();
  await page.getByRole("button", { name: "Subtitle style" }).click();
  await page.getByRole("radiogroup", { name: "Color" }).getByRole("radio", { name: "White" }).click();
  await expect(page.getByTestId("subtitles").locator("span")).toHaveCSS("color", "rgb(255, 255, 255)");
});

test("skips the intro when the source knows where it is", async ({ page }) => {
  await signIn(page);
  await page.goto("/en/watch/stub/4/3");
  const skip = page.getByRole("button", { name: "Skip intro" });
  await expect(skip).toBeVisible({ timeout: 10_000 });
  await skip.click();
  await expect.poll(() => currentTime(page)).toBeGreaterThanOrEqual(25);
  await expect(skip).toHaveCount(0);

  // Episode 2 has no skip data, so no button at any point.
  await page.goto("/en/watch/stub/4/2?t=3");
  await expect.poll(() => currentTime(page)).toBeGreaterThan(4);
  await expect(page.getByRole("button", { name: "Skip intro" })).toHaveCount(0);
});

test("says which source answered after a fallback", async ({ page }) => {
  await signIn(page);
  await page.goto("/en/watch/flaky/4/1");
  await expect(page.getByText("playing from stub")).toBeVisible();
});

test("stays in full screen when the next episode starts", async ({ page }) => {
  await signIn(page);
  await page.goto("/en/watch/stub/4/1");
  await expect.poll(() => video(page).evaluate((v: HTMLVideoElement) => v.duration)).toBeGreaterThan(30);
  await page.keyboard.press("f");
  const inFullscreen = () => page.evaluate(() => document.fullscreenElement?.hasAttribute("data-fullscreen-stage") ?? false);
  await expect.poll(inFullscreen).toBe(true);

  await page.keyboard.press("n");
  await expect(page).toHaveURL(/\/en\/watch\/stub\/4\/2$/);
  await expect(page.getByText("Episode 2", { exact: true })).toBeVisible();
  await expect.poll(inFullscreen).toBe(true);
  await expect(page.getByRole("button", { name: "Exit full screen" })).toBeVisible();
});

test("draws styled subtitles over the video instead of the plain ones", async ({ page }) => {
  await signIn(page);
  await page.goto("/en/watch/stub/7/1");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: /^Subtitles/ }).click();
  await page.getByRole("radio", { name: "Brazilian Portuguese" }).click();
  await page.getByRole("button", { name: "Close settings" }).click();
  await expect(page.getByTestId("ass-subtitles").locator("canvas")).toHaveCount(1);
  await expect(page.getByTestId("subtitles")).toHaveCount(0);
  // The plain WebVTT copy stays loaded for Safari's native full screen.
  await expect(video(page).locator("track")).toHaveCount(1);

  // The script paints the whole picture magenta; the canvas can't be read back, so look at the page.
  await expect
    .poll(async () => {
      const box = (await video(page).boundingBox())!;
      const shot = await page.screenshot({ clip: { x: box.x + box.width / 2, y: box.y + box.height / 2, width: 1, height: 1 } });
      return page.evaluate(async (png) => {
        const img = new Image();
        img.src = `data:image/png;base64,${png}`;
        await img.decode();
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 1;
        const context = canvas.getContext("2d")!;
        context.drawImage(img, 0, 0);
        const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
        return r > 200 && g < 60 && b > 200;
      }, shot.toString("base64"));
    }, { timeout: 15_000 })
    .toBe(true);
});
