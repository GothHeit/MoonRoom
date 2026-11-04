import { expect, test, type Browser } from "@playwright/test";

import { SECONDS, Session, type NetProfile } from "./harness";

// Networks seen in practice: same city, across the country, a phone on mobile data.
const NEAR: NetProfile = { latency: 20, jitter: 10 };
const MID: NetProfile = { latency: 150, jitter: 50, loss: 0.01 };
const FAR: NetProfile = { latency: 300, jitter: 100, loss: 0.03 };

// Measuring starts once everyone has had a moment to line up after the first play.
const SETTLE = 5;

let session: Session | undefined;

test.afterEach(async () => {
  await session?.close();
  session = undefined;
});

async function room(browser: Browser, scenario: string, nets: [string, NetProfile][]) {
  session = new Session(browser, scenario);
  const viewers = [];
  for (const [name, net] of nets) viewers.push(await session.viewer(name, net));
  await session.createRoom(viewers[0]);
  for (const v of viewers) await session.enter(v);
  await session.waitForMembers(viewers.length);
  return { s: session, viewers };
}

async function startPlaying(s: Session, host: Session["viewers"][number]) {
  await s.play(host);
  await s.wait(SETTLE);
  return Date.now();
}

test("same network, three viewers", async ({ browser }) => {
  const { s, viewers } = await room(browser, "lan-3", [["alice", {}], ["bob", {}], ["carol", {}]]);
  const from = await startPlaying(s, viewers[0]);
  await s.wait(SECONDS);
  const r = await s.finish(from);
  expect(r.spread.p50).not.toBeNaN();
});

test("mixed latency, three viewers", async ({ browser }) => {
  const { s, viewers } = await room(browser, "latency-3", [["alice", NEAR], ["bob", MID], ["carol", FAR]]);
  const from = await startPlaying(s, viewers[0]);
  await s.wait(SECONDS);
  await s.finish(from);
});

test("seeks by different viewers", async ({ browser }) => {
  const { s, viewers } = await room(browser, "seeks", [["alice", NEAR], ["bob", MID], ["carol", FAR]]);
  const from = await startPlaying(s, viewers[0]);
  const targets = [120, 300, 45, 480];
  for (let i = 0; i < targets.length; i++) {
    await s.seek(viewers[(i + 1) % viewers.length], targets[i]);
    await s.wait(SECONDS / targets.length);
  }
  await s.finish(from);
});

test("guests pause and resume", async ({ browser }) => {
  const { s, viewers } = await room(browser, "pause-play", [["alice", NEAR], ["bob", MID], ["carol", FAR]]);
  const [, bob, carol] = viewers;
  const from = await startPlaying(s, viewers[0]);
  const step = SECONDS / 4;
  await s.pause(carol);
  await s.wait(step);
  await s.play(carol);
  await s.wait(step);
  await s.pause(bob);
  await s.wait(step);
  await s.play(bob);
  await s.wait(step);
  await s.finish(from);
});

test("someone joins a playing room", async ({ browser }) => {
  session = new Session(browser, "late-join");
  const s = session;
  const alice = await s.viewer("alice", NEAR);
  const bob = await s.viewer("bob", MID);
  const carol = await s.viewer("carol", MID);
  await s.createRoom(alice);
  await s.enter(alice);
  await s.enter(bob);
  await s.waitForMembers(2);
  await s.play(alice);
  await s.wait(SETTLE);
  await s.enter(carol);
  // Carol's samples only start once she is in, so the measurement starts there too.
  const from = Date.now();
  s.mark("carol joins");
  await s.wait(SECONDS);
  await s.finish(from);
});

test("one viewer's connection is too slow for the video", async ({ browser }) => {
  const { s, viewers } = await room(browser, "slow-viewer", [
    ["alice", NEAR],
    ["bob", NEAR],
    // The test video needs about 470 kbit/s.
    ["carol", { ...MID, segmentKbps: 420 }],
  ]);
  const from = await startPlaying(s, viewers[0]);
  await s.wait(SECONDS * 1.5);
  await s.finish(from);
});

test("a viewer drops off for ten seconds and comes back", async ({ browser }) => {
  const { s, viewers } = await room(browser, "drop", [["alice", NEAR], ["bob", MID], ["carol", FAR]]);
  const from = await startPlaying(s, viewers[0]);
  await s.wait(SECONDS / 4);
  await s.drop(viewers[1], 10_000);
  // While Bob is gone, the room moves on without him.
  await s.wait(3);
  await s.seek(viewers[0], 200);
  await s.wait(SECONDS * 0.75);
  await s.finish(from);
});

test("five viewers on mixed networks", async ({ browser }) => {
  const { s, viewers } = await room(browser, "five", [
    ["alice", NEAR],
    ["bob", { latency: 60, jitter: 20 }],
    ["carol", MID],
    ["dave", { latency: 200, jitter: 60, loss: 0.02 }],
    ["erin", FAR],
  ]);
  const from = await startPlaying(s, viewers[0]);
  await s.wait(SECONDS);
  await s.finish(from);
});
