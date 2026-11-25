import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

import { signIn } from "../e2e/helpers";

const CLIP = readFileSync(join(__dirname, "../e2e/fixtures/clip.webm"));
const SYNC_TOLERANCE = 1.6;

/** `answers` says which stream plays for each one asked (by "source:lang"); unset plays the asked one. */
async function stubVideo(page: Page, answers: Record<string, string> = {}) {
  await page.route(/\/api\/proxy\/watch\/zoko\/\d+\/episodes(\?|$)/, (route) =>
    route.fulfill({ json: { source: "zoko", source_title: "Test", episodes: [1, 2, 3], thumbnails: {} } }),
  );
  await page.route(/\/api\/proxy\/watch\/\w+\/\d+\/episodes\/\d+\/play/, (route) => {
    const url = new URL(route.request().url());
    const asked = `${url.pathname.split("/").at(-5)}:${url.searchParams.get("lang") ?? "sub"}`;
    const [source, lang] = (answers[asked] ?? asked).split(":");
    return route.fulfill({
      json: { source, lang, kind: "mp4", resolution: null, url: "/watch/video?token=clip", subtitles: [], skips: [] },
    });
  });
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

async function viewer(browser: Browser, username: string, answers: Record<string, string> = {}): Promise<Page> {
  const context = await browser.newContext();
  contexts.push(context);
  const page = await context.newPage();
  await stubVideo(page, answers);
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
  await expect(host.getByRole("button", { name: /People, 2 watching/ })).toBeVisible();
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
  await expect(guest.getByRole("button", { name: "Close settings" })).toBeVisible();
  // A room plays at the room's speed, and only the host picks the source.
  await expect(guest.getByRole("button", { name: /^Playback speed/ })).toHaveCount(0);
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

test("a stream that can't play for the host moves the room to the one that did", async ({ browser }) => {
  // The dub can't play here: the API answers with the sub instead.
  const host = await viewer(browser, "alice", { "zoko:dub": "zoko:sub" });
  const guest = await viewer(browser, "bob");
  const code = await createRoom(host);
  await enter(host, code);
  await enter(guest, code);
  await expect(host.getByRole("button", { name: /People, 2 watching/ })).toBeVisible();

  const reloaded = guest.waitForRequest(/\/episodes\/1\/play\?lang=sub/);
  await host.getByRole("button", { name: "Settings" }).click();
  await host.getByRole("button", { name: /^Source/ }).click();
  const dub = host.waitForRequest(/\/episodes\/1\/play\?lang=dub/);
  await host.getByRole("radio", { name: "Zoko · English dub" }).click();
  await dub;
  await expect(host.getByText("Zoko · English dub couldn't play this episode, so the room moved everyone to Zoko · Subtitled.")).toBeVisible();
  await reloaded;
  // Everyone ends up on the stream that plays, so nobody is told they are out of step.
  await expect(host.getByText(/The room plays/)).toHaveCount(0);
  await expect(guest.getByText(/The room plays/)).toHaveCount(0);
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

  await host.getByRole("button", { name: /^People/ }).click();
  await host.getByRole("switch", { name: "Only the host controls playback" }).click();
  await expect(guest.getByRole("button", { name: /^People/ })).toBeVisible();

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

test("chat reaches the other viewer, beside the video or over it", async ({ browser }) => {
  const { host, guest } = await pair(browser);
  // A computer screen opens the room with the chat beside the video.
  const hostPanel = host.getByRole("complementary", { name: "Watch together" });
  await expect(hostPanel.getByText("bob joined")).toBeVisible();
  await guest.getByRole("textbox", { name: "Message" }).fill("hello moon");
  await guest.keyboard.press("Enter");
  await expect(hostPanel.getByText("hello moon")).toBeVisible();

  // With the chat closed, a new message shows over the video and the button counts it.
  await host.getByRole("button", { name: /^Close chat/ }).click();
  await expect(hostPanel).toBeHidden();
  await guest.getByRole("textbox", { name: "Message" }).fill("over the video");
  await guest.keyboard.press("Enter");
  await expect(host.getByText("over the video")).toBeVisible();
  await expect(host.getByRole("button", { name: "Open chat, 1 new message" })).toBeVisible();
  await host.getByRole("button", { name: /^Open chat/ }).click();
  await expect(hostPanel.getByText("over the video")).toBeVisible();
});

test("a TV joins a friend's open room from Home with the remote and follows it", async ({ browser }) => {
  const host = await viewer(browser, "carol");
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  contexts.push(context);
  const tv = await context.newPage();
  await stubVideo(tv);
  await signIn(tv, "en", "dave");
  // Friends: one asks, the other asking back accepts.
  expect((await host.request.post("/api/proxy/friends/requests", { data: { username: "dave" } })).status()).toBe(201);
  expect((await tv.request.post("/api/proxy/friends/requests", { data: { username: "carol" } })).status()).toBe(201);

  const created = await host.request.post("/api/proxy/watch/rooms", {
    data: { source: "zoko", anime_id: 4, title: "Moon Test", episode: 1, open: true },
  });
  const code: string = (await created.json()).code;
  await enter(host, code);

  // Opening the TV app asks who is watching first.
  await tv.goto("/en/tv");
  await tv.getByRole("button", { name: "dave" }).click();
  const card = tv.getByRole("link", { name: "Join carol watching Moon Test" });
  await expect(card).toBeVisible();
  // A held key's pace: the remote navigation ignores presses closer together than that.
  const press = async (key: string) => {
    await tv.keyboard.press(key);
    await tv.waitForTimeout(150);
  };
  for (let i = 0; i < 4 && !(await card.evaluate((el) => el === document.activeElement)); i++) await press("ArrowDown");
  await expect(card).toBeFocused();
  await press("Enter");
  await expect(tv).toHaveURL(new RegExp(`/en/tv/room/${code}$`));
  await expect.poll(() => tv.locator("video").evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThanOrEqual(2);
  await expect(host.getByRole("button", { name: /People, 2 watching/ })).toBeVisible();
  await expect(tv.getByText("2 watching")).toBeVisible();

  // The room plays: the TV follows.
  await host.getByRole("button", { name: "Play", exact: true }).click();
  await expect.poll(() => playing(tv)).toBe(true);
  await expectInSync(host, tv);

  // OK on the remote pauses everyone, and a friend's message shows over the TV's picture.
  await settle(tv);
  await press("Enter");
  if (await playing(tv)) await press("Enter");
  await expect.poll(() => playing(host)).toBe(false);
  await host.getByRole("textbox", { name: "Message" }).fill("hello tv");
  await host.keyboard.press("Enter");
  await expect(tv.getByText("hello tv")).toBeVisible();

  // Back leaves the room and returns to Home.
  await press("Escape");
  await expect(tv).toHaveURL(/\/en\/tv$/);
  await expect(host.getByRole("button", { name: /People, 1 watching/ })).toBeVisible();
});
