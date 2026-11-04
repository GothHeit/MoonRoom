import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, type Browser, type BrowserContext, type Page } from "@playwright/test";

import { signIn } from "../e2e/helpers";

import { CONTROL_PORT } from "./ports";

import { FIXTURE_DIR } from "./fixture";
import { installShim } from "./shim";

export const REPORT_DIR = process.env.SYNC_REPORT_DIR ?? join(__dirname, "..", "test-results", "sync");
/** How long each scenario plays, in seconds. Longer runs give steadier numbers. */
export const SECONDS = Number(process.env.SYNC_SECONDS ?? 40);

export type NetProfile = {
  /** One-way delay of the room's events and commands, in ms. */
  latency?: number;
  /** Random +/- on top of the latency, in ms. */
  jitter?: number;
  /** Share of messages that need a resend (0 to 1). */
  loss?: number;
  /** Download speed for video segments, in kbit/s. Unset is unlimited. */
  segmentKbps?: number;
  /** How far the viewer's clock is off, in ms. */
  skew?: number;
};

export type Viewer = { name: string; page: Page; net: NetProfile };

const SEGMENT = /\/api\/stream\/hls\/sync\/([\w.]+)$/;

async function stubVideo(page: Page, net: NetProfile) {
  await page.route(/\/api\/proxy\/watch\/zoko\/\d+\/episodes(\?|$)/, (route) =>
    route.fulfill({ json: { source: "zoko", source_title: "Test", episodes: [1, 2, 3], thumbnails: {} } }),
  );
  await page.route(/\/api\/proxy\/watch\/zoko\/\d+\/episodes\/\d+\/play/, (route) =>
    route.fulfill({
      json: { source: "zoko", kind: "hls", resolution: 360, url: "/watch/hls/sync/index.m3u8", subtitles: [], skips: [] },
    }),
  );
  await page.route(/\/api\/proxy\/watch\/options\/\d+\/\d+/, (route) =>
    route.fulfill({ json: [{ source: "zoko", lang: "sub" }] }),
  );
  await page.route(/\/api\/proxy\/watch\/choice\/\d+/, (route) => route.fulfill({ status: 204 }));
  await page.route(SEGMENT, async (route) => {
    const name = SEGMENT.exec(route.request().url())![1];
    const file = join(FIXTURE_DIR, name);
    const body = readFileSync(file);
    if (net.segmentKbps) {
      const ms = (statSync(file).size * 8) / net.segmentKbps;
      await new Promise((resolve) => setTimeout(resolve, ms));
    }
    await route.fulfill({
      body,
      contentType: name.endsWith(".m3u8") ? "application/vnd.apple.mpegurl" : "video/mp2t",
    });
  });
}

export class Session {
  readonly viewers: Viewer[] = [];
  readonly marks: { t: number; label: string }[] = [];
  private entered = new Set<Viewer>();
  private contexts: BrowserContext[] = [];
  code = "";
  started = 0;

  constructor(
    private browser: Browser,
    readonly scenario: string,
  ) {}

  async viewer(name: string, net: NetProfile = {}): Promise<Viewer> {
    const context = await this.browser.newContext();
    this.contexts.push(context);
    const page = await context.newPage();
    await page.addInitScript(installShim, {
      latency: net.latency ?? 0,
      jitter: net.jitter ?? 0,
      loss: net.loss ?? 0,
      skew: net.skew ?? 0,
    });
    await stubVideo(page, net);
    await signIn(page, "en", name);
    const viewer = { name, page, net };
    this.viewers.push(viewer);
    return viewer;
  }

  async createRoom(host: Viewer) {
    const response = await host.page.request.post("/api/proxy/watch/rooms", {
      data: { source: "zoko", anime_id: 4, episode: 1 },
    });
    expect(response.status()).toBe(201);
    this.code = (await response.json()).code;
  }

  async enter(viewer: Viewer) {
    const { page } = viewer;
    await page.goto(`/en/room/${this.code}`);
    this.entered.add(viewer);
    await expect(page.locator("video")).toBeVisible();
    await expect
      .poll(() => page.locator("video").evaluate((v: HTMLVideoElement) => v.readyState), { timeout: 30_000 })
      .toBeGreaterThanOrEqual(2);
  }

  async waitForMembers(count: number) {
    for (const { name, page } of this.entered) {
      await expect(
        page.getByRole("button", { name: new RegExp(`People, ${count} watching`) }),
        `${name} sees ${count} people in the room`,
      ).toBeVisible({ timeout: 20_000 });
    }
  }

  mark(label: string) {
    this.marks.push({ t: Date.now(), label });
  }

  /** The viewer does what a person would: their own play, pause or seek on the video. */
  async play(viewer: Viewer) {
    this.mark(`${viewer.name} plays`);
    await viewer.page.locator("video").evaluate((v: HTMLVideoElement) => void v.play());
  }

  async pause(viewer: Viewer) {
    this.mark(`${viewer.name} pauses`);
    await viewer.page.locator("video").evaluate((v: HTMLVideoElement) => v.pause());
  }

  async seek(viewer: Viewer, to: number) {
    this.mark(`${viewer.name} seeks to ${to}`);
    await viewer.page.locator("video").evaluate((v: HTMLVideoElement, t) => (v.currentTime = t), to);
  }

  async drop(viewer: Viewer, ms: number) {
    this.mark(`${viewer.name} drops for ${ms / 1000} s`);
    await viewer.page.evaluate((m) => (window as unknown as { __drop: (ms: number) => void }).__drop(m), ms);
  }

  /** Kills the API without warning and starts it again after `downMs`. */
  async restartServer(downMs: number) {
    const response = await fetch(`http://localhost:${CONTROL_PORT}/restart?down=${downMs}`, { method: "POST" });
    expect(response.ok).toBe(true);
  }

  async wait(seconds: number) {
    await this.viewers[0].page.waitForTimeout(seconds * 1000);
  }

  /** Collects every viewer's samples, works out the numbers and writes them for the report. */
  async finish(from: number) {
    const traces: Trace[] = [];
    for (const v of this.viewers) {
      const data = await v.page.evaluate(
        () => (window as unknown as { __sync: { samples: number[][]; events: { t: number; type: string }[] } }).__sync,
      );
      traces.push({ name: v.name, net: v.net, samples: data.samples, events: data.events });
    }
    const result = measure(this.scenario, traces, this.marks, from, Date.now());
    mkdirSync(REPORT_DIR, { recursive: true });
    writeFileSync(join(REPORT_DIR, `${this.scenario}.json`), JSON.stringify(result, null, 2));
    return result;
  }

  async close() {
    await Promise.all(this.contexts.splice(0).map((c) => c.close()));
  }
}

type Trace = { name: string; net: NetProfile; samples: number[][]; events: { t: number; type: string }[] };

/** Where a viewer's playhead was at time t, from the samples around it. */
function stateAt(samples: number[][], t: number): { pos: number; paused: boolean; ready: boolean } | null {
  let lo = 0;
  let hi = samples.length - 1;
  if (hi < 1 || t < samples[0][0] || t > samples[hi][0]) return null;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (samples[mid][0] <= t) lo = mid;
    else hi = mid;
  }
  const [t0, p0, paused0, , rs0] = samples[lo];
  const [t1, p1, paused1, , rs1] = samples[hi];
  const paused = paused0 === 1 || paused1 === 1;
  // A jump between two samples is a seek; take the nearer one rather than a made-up middle.
  const jumped = Math.abs(p1 - p0 - (paused ? 0 : (t1 - t0) / 1000)) > 0.5;
  const pos = jumped ? (t - t0 < t1 - t && !paused ? p0 + (t - t0) / 1000 : p1) : p0 + ((p1 - p0) * (t - t0)) / (t1 - t0 || 1);
  return { pos, paused, ready: rs0 >= 3 && rs1 >= 3 };
}

const STEP_MS = 100;
/** In sync: everyone within this much of each other. */
const IN_SYNC = 0.25;
/** Back together after an action: within this much, for a second. */
const TOGETHER = 0.5;
/** The steady-state numbers leave out this long after each action; recovery covers it. */
const TRANSITION_MS = 3000;

function quantile(sorted: number[], q: number) {
  if (sorted.length === 0) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

export type Result = ReturnType<typeof measure>;

function measure(
  scenario: string,
  traces: Trace[],
  marks: { t: number; label: string }[],
  from: number,
  to: number,
) {
  const spreads: number[] = [];
  const timeline: { t: number; spread: number | null; offsets: (number | null)[] }[] = [];
  let disagree = 0;
  let total = 0;
  const offsets: number[][] = traces.map(() => []);
  for (let t = from; t <= to; t += STEP_MS) {
    const states = traces.map((tr) => stateAt(tr.samples, t));
    if (states.some((s) => s === null)) continue;
    total++;
    const list = states as { pos: number; paused: boolean; ready: boolean }[];
    const allPlaying = list.every((s) => !s.paused);
    const allPaused = list.every((s) => s.paused);
    if (!allPlaying && !allPaused) {
      disagree++;
      timeline.push({ t: t - from, spread: null, offsets: list.map(() => null) });
      continue;
    }
    const positions = list.map((s) => s.pos);
    const sorted = [...positions].sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1];
    const spread = sorted[sorted.length - 1] - sorted[0];
    const transition = marks.some((m) => t >= m.t && t - m.t < TRANSITION_MS);
    if (!transition) spreads.push(spread);
    positions.forEach((p, i) => offsets[i].push(p - median));
    timeline.push({ t: t - from, spread, offsets: positions.map((p) => p - median) });
  }
  const sorted = [...spreads].sort((a, b) => a - b);

  // After each action: how long until everyone is within TOGETHER of each other for a second.
  const recover = marks
    .filter((m) => m.t >= from)
    .map((m) => {
      let since: number | null = null;
      for (const point of timeline) {
        const at = point.t + from;
        if (at < m.t) continue;
        if (point.spread !== null && point.spread < TOGETHER) {
          since ??= at;
          if (at - since >= 1000) return { label: m.label, seconds: (since - m.t) / 1000 };
        } else since = null;
      }
      return { label: m.label, seconds: null };
    });

  const count = (tr: Trace, type: string) => tr.events.filter((e) => e.type === type && e.t >= from).length;
  return {
    scenario,
    seconds: (to - from) / 1000,
    spread: {
      p50: quantile(sorted, 0.5),
      p95: quantile(sorted, 0.95),
      max: sorted[sorted.length - 1] ?? NaN,
      inSyncShare: spreads.filter((s) => s < IN_SYNC).length / (spreads.length || 1),
    },
    // Share of the time some viewers played while others were paused.
    disagreeShare: disagree / (total || 1),
    recover,
    viewers: traces.map((tr, i) => {
      const o = offsets[i];
      return {
        name: tr.name,
        net: tr.net,
        meanOffset: o.length ? o.reduce((a, b) => a + b, 0) / o.length : NaN,
        meanAbsOffset: o.length ? o.reduce((a, b) => a + Math.abs(b), 0) / o.length : NaN,
        seeks: count(tr, "seeking"),
        stalls: count(tr, "waiting"),
      };
    }),
    // Every 500 ms, for the chart.
    timeline: timeline.filter((_, i) => i % 5 === 0),
  };
}
