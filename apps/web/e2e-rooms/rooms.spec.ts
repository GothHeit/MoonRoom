import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

import { signIn } from "../e2e/helpers";

const CLIP = readFileSync(join(__dirname, "../e2e/fixtures/clip.webm"));
const SYNC_TOLERANCE = 1.6;

async function stubVideo(page: Page) {
  await page.route(/\/api\/proxy\/watch\/zoko\/\d+\/episodes(\?|$)/, (route) =>
    route.fulfill({ json: { source: "zoko", source_title: "Test", episodes: [1, 2, 3], thumbnails: {} } }),
  );
  await page.route(/\/api\/proxy\/watch\/zoko\/\d+\/episodes\/\d+\/play/, (route) =>
    route.fulfill({
      json: { source: "zoko", kind: "mp4", resolution: null, url: "/watch/video?token=clip", subtitles: [], skips: [] },
    }),
  );
  await page.route(/\/api\/proxy\/watch\/options\/\d+\/\d+/, (route) =>
    route.fulfill({ json: [{ source: "zoko", lang: "sub" }, { source: "zoko", lang: "dub" }] }),
  );
  await page.route(/\/api\/proxy\/watch\/choice\/\d+/, (route) => route.fulfill({ status: 204 }));
  await page.route("**/api/stream/video?token=clip", (route) => {
    const range = /bytes=(\d+)-(\d*)/.exec(route.request().headers()["range"] ?? "");
    if (!range) return route.fulfill({ body: CLIP, contentType: "video/webm", headers: { "Accept-Ranges": "bytes" } });
    const start = Number(range[1]);
    const end = range[2] ? Math.min(Number(range[2]), CLIP.length - 1) : CLIP.length - 1;
    return route.fulfill({
      status: 206,
      body: CLIP.subarray(start, end + 1),
      contentType: "video/webm",
      headers: { "Accept-Ranges": "bytes", "Content-Range": `bytes ${start}-${end}/${CLIP.length}` },
    });
  });
}

const contexts: BrowserContext[] = [];

// Leaving a room is closing the tab, so every test closes its viewers.
test.afterEach(async () => {
  await Promise.all(contexts.splice(0).map((c) => c.close()));
});

async function viewer(browser: Browser, username: string): Promise<Page> {
  const context = await browser.newContext();
  contexts.push(context);
  const page = await context.newPage();
  await stubVideo(page);
  await signIn(page, "en", username);
  return page;
}

async function createRoom(host: Page): Promise<string> {
  const response = await host.request.post("/api/proxy/watch/rooms", {
    data: { source: "zoko", anime_id: 4, title: "Moon Test", episode: 1 },
  });
  expect(response.status()).toBe(201);
  return (await response.json()).code;
}

async function enter(page: Page, code: string) {
  await page.goto(`/en/room/${code}`);
  await expect(page.locator("video")).toBeVisible();
  await expect.poll(() => page.locator("video").evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThanOrEqual(2);
}

const playing = (page: Page) => page.locator("video").evaluate((v: HTMLVideoElement) => !v.paused);
const time = (page: Page) => page.locator("video").evaluate((v: HTMLVideoElement) => v.currentTime);
const seek = (page: Page, to: number) => page.locator("video").evaluate((v: HTMLVideoElement, t) => (v.currentTime = t), to);

async function pair(browser: Browser) {
  const host = await viewer(browser, "alice");
  const guest = await viewer(browser, "bob");
  const code = await createRoom(host);
  await enter(host, code);
  await enter(guest, code);
  // Both have joined once each sees two people.
  await expect(host.getByRole("button", { name: /Room panel, 2 watching/ })).toBeVisible();
  return { host, guest, code };
}

// A player ignores its own events for a moment after the room moves it, so a viewer's next
// action has to come after that.
const settle = (page: Page) => page.waitForTimeout(1000);

async function expectInSync(a: Page, b: Page) {
  await expect.poll(async () => Math.abs((await time(a)) - (await time(b)))).toBeLessThan(SYNC_TOLERANCE);
}

test("play and pause reach everyone", async ({ browser }) => {
  const { host, guest } = await pair(browser);
  expect(await playing(host)).toBe(false);

  await host.keyboard.press("Space");
  await expect.poll(() => playing(guest)).toBe(true);
  await expect.poll(() => playing(host)).toBe(true);

  await settle(guest);
  await guest.keyboard.press("Space");
  await expect.poll(() => playing(host)).toBe(false);
  await expect.poll(() => playing(guest)).toBe(false);
  await expectInSync(host, guest);
});

test("the host switches everyone to another source where the room is", async ({ browser }) => {
  const { host, guest } = await pair(browser);
  await guest.getByRole("button", { name: "Settings" }).click();
  await expect(guest.getByRole("button", { name: /^Playback speed/ })).toBeVisible();
  await expect(guest.getByRole("button", { name: /^Source/ })).toHaveCount(0);
  await guest.getByRole("button", { name: "Close settings" }).click();

  await seek(host, 15);
  await expect.poll(() => time(guest)).toBeGreaterThan(14);
  const reloaded = guest.waitForRequest(/\/episodes\/1\/play\?lang=dub/);
  await host.getByRole("button", { name: "Settings" }).click();
  await host.getByRole("button", { name: /^Source/ }).click();
  await host.getByRole("radio", { name: "Zoko · English dub" }).click();
  await reloaded;
  await expect.poll(() => time(guest)).toBeGreaterThan(14);
  await expectInSync(host, guest);
});

test("a seek moves everyone, whoever makes it", async ({ browser }) => {
  const { host, guest } = await pair(browser);
  await seek(host, 20);
  await expect.poll(() => time(guest)).toBeGreaterThan(19);
  await settle(guest);
  await seek(guest, 5);
  await expect.poll(() => time(host)).toBeLessThan(7);
  await expectInSync(host, guest);
});

test("someone who joins late lands where the room is, already playing", async ({ browser }) => {
  const host = await viewer(browser, "alice");
  const code = await createRoom(host);
  await enter(host, code);
  await seek(host, 10);
  await host.keyboard.press("Space");
  await expect.poll(() => playing(host)).toBe(true);
  await host.waitForTimeout(1500);

  const late = await viewer(browser, "bob");
  await enter(late, code);
  await expect.poll(() => playing(late)).toBe(true);
  await expect.poll(() => time(late)).toBeGreaterThan(10);
  await expectInSync(host, late);
});

test("a viewer who drifts is pulled back, and locked controls undo their seek", async ({ browser }) => {
  const { host, guest } = await pair(browser);
  await host.keyboard.press("Space");
  await expect.poll(() => playing(guest)).toBe(true);

  await host.getByRole("button", { name: /Room panel/ }).click();
  await host.getByRole("switch", { name: "Only the host controls playback" }).click();
  await expect(guest.getByRole("button", { name: /Room panel/ })).toBeVisible();

  await settle(guest);
  await seek(guest, 30);
  await expect.poll(() => time(guest), { timeout: 8000 }).toBeLessThan(20);
  await expect(guest.getByText("Only the host can control playback in this room.")).toBeVisible();
  await expectInSync(host, guest);
  // The host's own controls still work.
  await settle(host);
  await seek(host, 25);
  await expect.poll(() => time(guest)).toBeGreaterThan(24);
});

test("everyone waits for a viewer whose video stalls, then carries on", async ({ browser }) => {
  const { host, guest } = await pair(browser);
  await host.keyboard.press("Space");
  await expect.poll(() => playing(guest)).toBe(true);

  await guest.locator("video").evaluate((v) => v.dispatchEvent(new Event("waiting")));
  await expect.poll(() => playing(host)).toBe(false);
  await expect(host.getByText("Waiting for bob…")).toBeVisible();
  const held = await time(host);

  await host.waitForTimeout(1200);
  expect(Math.abs((await time(host)) - held)).toBeLessThan(0.5);

  await guest.locator("video").evaluate((v) => v.dispatchEvent(new Event("playing")));
  await expect.poll(() => playing(host)).toBe(true);
  await expect.poll(() => playing(guest)).toBe(true);
  await expect(host.getByText("Waiting for bob…")).toBeHidden();
});

test("a stall that never ends stops holding the room after a timeout", async ({ browser }) => {
  const { host, guest } = await pair(browser);
  await host.keyboard.press("Space");
  await expect.poll(() => playing(guest)).toBe(true);

  await guest.locator("video").evaluate((v) => v.dispatchEvent(new Event("waiting")));
  await expect.poll(() => playing(host)).toBe(false);
  await expect.poll(() => playing(host), { timeout: 15_000 }).toBe(true);
  await expect(host.getByText("Waiting for bob…")).toBeHidden();
});

test("chat reaches the other viewer", async ({ browser }) => {
  const { host, guest } = await pair(browser);
  await guest.getByRole("button", { name: /Room panel/ }).click();
  await guest.getByRole("textbox", { name: "Message" }).fill("hello moon");
  await guest.keyboard.press("Enter");
  await host.getByRole("button", { name: /Room panel/ }).click();
  await expect(host.getByText("hello moon")).toBeVisible();
});
