/**
 * Runs in every viewer's page before the app does (page.addInitScript), so it must stay
 * self-contained: no imports, no closures over this module.
 *
 * - A network shim for the room's traffic only: room events (server-sent) and room commands
 *   (fetch) are delayed by the viewer's latency and jitter, in order, and a lost packet costs a
 *   retransmit. `__drop(ms)` cuts the room connection like a network blip and lets it come back.
 * - A sampler that records the video's playhead every 50 ms and its media events, all on the
 *   machine's one clock, so viewers can be compared with each other afterwards.
 */
export function installShim(initial?: { latency: number; jitter: number; loss: number }) {
  type Net = { latency: number; jitter: number; loss: number; down: boolean };
  type Listener = (event: Event) => void;
  const w = window as unknown as Record<string, unknown>;
  const net: Net = { latency: 0, jitter: 0, loss: 0, ...initial, down: false };
  w.__net = net;

  const delay = () => {
    let ms = net.latency + (Math.random() * 2 - 1) * net.jitter;
    // TCP never loses a message, it resends it: about 200 ms plus a round trip later.
    if (Math.random() < net.loss) ms += 200 + 2 * net.latency;
    return Math.max(0, ms);
  };

  const samples: number[][] = [];
  const events: { t: number; type: string }[] = [];
  w.__sync = { samples, events };
  for (const type of ["seeking", "waiting", "playing", "pause", "play", "ratechange"]) {
    document.addEventListener(type, () => events.push({ t: Date.now(), type }), true);
  }
  setInterval(() => {
    const v = document.querySelector("video");
    if (!v) return;
    samples.push([Date.now(), v.currentTime, v.paused ? 1 : 0, v.playbackRate, v.readyState]);
  }, 50);

  const Real = window.EventSource;
  const open = new Set<Shim>();

  class Shim extends EventTarget {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSED = 2;
    readonly CONNECTING = 0;
    readonly OPEN = 1;
    readonly CLOSED = 2;
    onopen: Listener | null = null;
    onerror: Listener | null = null;
    onmessage: Listener | null = null;
    readonly url: string;
    readonly withCredentials = false;
    private real: EventSource | null = null;
    private closed = false;
    private lastAt = 0;
    private named: [string, Listener][] = [];

    constructor(url: string | URL, private init?: EventSourceInit) {
      super();
      this.url = String(url);
      this.connect();
      open.add(this);
    }

    get readyState() {
      if (this.closed) return 2;
      return this.real ? this.real.readyState : 0;
    }

    /** Delivers in order, each event no earlier than its own delay. */
    private later(run: () => void) {
      const now = Date.now();
      const at = Math.max(this.lastAt, now + delay());
      this.lastAt = at;
      setTimeout(run, at - now);
    }

    private attach(real: EventSource, name: string, fn: Listener) {
      real.addEventListener(name, (event) => this.later(() => this.real === real && fn(event)));
    }

    connect() {
      if (this.closed) return;
      const real = new Real(this.url, this.init);
      this.real = real;
      real.onopen = (event) => this.later(() => this.onopen?.(event));
      real.onerror = (event) => this.onerror?.(event);
      real.onmessage = (event) => this.later(() => this.onmessage?.(event));
      for (const [name, fn] of this.named) this.attach(real, name, fn);
    }

    drop(ms: number) {
      if (this.closed || !this.real) return;
      this.real.close();
      this.real = null;
      // What the browser reports when a live connection breaks: an error while reconnecting.
      this.onerror?.(new Event("error"));
      setTimeout(() => this.connect(), ms);
    }

    addEventListener(name: string, fn: EventListenerOrEventListenerObject | null) {
      if (!fn) return;
      const call: Listener = typeof fn === "function" ? fn : (event) => fn.handleEvent(event);
      this.named.push([name, call]);
      if (this.real) this.attach(this.real, name, call);
    }

    close() {
      this.closed = true;
      this.real?.close();
      open.delete(this);
    }
  }
  window.EventSource = Shim as unknown as typeof EventSource;

  w.__drop = (ms: number) => {
    net.down = true;
    setTimeout(() => (net.down = false), ms);
    for (const source of open) source.drop(ms);
  };

  const realFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/api/proxy/watch/rooms/")) {
      if (net.down) throw new TypeError("Failed to fetch");
      await new Promise((resolve) => setTimeout(resolve, delay()));
      if (net.down) throw new TypeError("Failed to fetch");
    }
    return realFetch(input, init);
  };
}
