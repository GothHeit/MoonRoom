// Minimal stand-in for the API, so the web e2e tests need no database.
import { createServer } from "node:http";

import { choiceFor, handleWatch } from "./fake-watch.mjs";

// The saved subtitle choice, like the real account setting.
let subtitleLang = null;
// Other devices shown in the sessions list; revoking one removes it.
const otherSessions = new Set(["phone"]);

const PORT = Number(process.env.FAKE_API_PORT ?? 4010);
const accessTokens = new Set();
const spentRefresh = new Set();
const liveRefresh = new Set();
let counter = 0;
let refreshCalls = 0;

function issue(tag = "") {
  counter += 1;
  const tokens = {
    access_token: `access-${tag}${counter}`,
    refresh_token: `refresh-${counter}`,
    token_type: "bearer",
    expires_in: 900,
  };
  accessTokens.add(tokens.access_token);
  liveRefresh.add(tokens.refresh_token);
  return tokens;
}

async function body(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const text = Buffer.concat(chunks).toString();
  return text ? JSON.parse(text) : {};
}

const card = (id, title, genres = []) => ({ id, title, genres, mean: 8.4, start_season: { year: 2024, season: "fall" } });
const CATALOG = [
  card(1, "Frieren", [{ id: 1, name: "Adventure" }]),
  card(2, "Dungeon Meshi", [{ id: 2, name: "Fantasy" }]),
  card(3, "Fullmetal Alchemist", [{ id: 1, name: "Adventure" }]),
];
const GENRES = [
  { id: 1, name: "Adventure", kind: "genre", nsfw: false },
  { id: 2, name: "Fantasy", kind: "genre", nsfw: false },
];
const HOME = {
  heroes: [
    { anime: CATALOG[0], synopsis: "A mage walks on.", backdrop: null },
    { anime: CATALOG[1], synopsis: "Dinner is dungeon.", backdrop: null },
  ],
  rows: [
    {
      id: "continue_watching",
      items: [
        {
          anime: CATALOG[0],
          resume_episode: 2,
          progress: { anime_id: 1, episode: 2, position_seconds: 600, duration_seconds: 1200, completed: false, updated_at: "2026-01-01T00:00:00Z" },
        },
      ],
    },
    { id: "seasonal", items: CATALOG.map((anime) => ({ anime })) },
    { id: "genre", genre: GENRES[1], items: [{ anime: CATALOG[1] }] },
  ],
};

// The "linked" user's MyAnimeList list: anime id -> status. Moves and removals change it.
const linkedList = new Map([
  [1, "watching"],
  [2, "watching"],
  [3, "completed"],
]);
const listItem = (id) => {
  const status = linkedList.get(id);
  const node = CATALOG.find((a) => a.id === id);
  return { node, list_status: { status, score: 0, num_episodes_watched: status === "completed" ? 12 : 3 } };
};

const error = (code) => ({ error: { code, message: code } });

createServer(async (req, res) => {
  const send = (status, json) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(json === undefined ? undefined : JSON.stringify(json));
  };
  const url = new URL(req.url, "http://x");

  if (url.pathname === "/health") return send(200, { status: "ok" });
  if (url.pathname === "/notifications") return send(200, { items: [], unread: 0 });
  if (url.pathname === "/notifications/settings") return send(200, { muted: [] });
  if (url.pathname === "/me/2fa") return send(200, { enabled: false, backup_codes_left: 0 });
  if (url.pathname === "/__stats") return send(200, { refreshCalls });

  if (url.pathname === "/auth/login") {
    const { username, password } = await body(req);
    // "expired" signs in fine but has a MyAnimeList link whose token has expired; "linked" has a
    // working link and a small list.
    const tag = { expired: "expired-", linked: "linked-" }[username] ?? "";
    return (username === "kafka" || username in { expired: 1, linked: 1 }) && password === "password123"
      ? send(200, issue(tag))
      : send(401, error("invalid_credentials"));
  }
  if (url.pathname === "/auth/register") {
    const { invite_code, username } = await body(req);
    if (invite_code !== "GOOD-INVITE") return send(400, error("invalid_invite"));
    if (username === "kafka") return send(409, error("username_taken"));
    return send(201, issue());
  }
  if (url.pathname === "/auth/refresh") {
    refreshCalls += 1;
    const { refresh_token } = await body(req);
    // Like the real API: a rotated token can be used once, a second use is rejected.
    if (!liveRefresh.has(refresh_token) || spentRefresh.has(refresh_token)) {
      return send(401, error("invalid_refresh_token"));
    }
    spentRefresh.add(refresh_token);
    return send(200, issue());
  }
  if (url.pathname === "/auth/logout") {
    const { refresh_token } = await body(req);
    liveRefresh.delete(refresh_token);
    return send(204);
  }
  const token = req.headers.authorization?.replace("Bearer ", "");
  const authed = Boolean(token && accessTokens.has(token));
  // Title 5's list entry can't be loaded, like a MyAnimeList outage.
  if (authed && req.method === "GET" && url.pathname === "/me/animelist/5") {
    return send(502, error("mal_unavailable"));
  }
  if (authed && token.includes("linked-")) {
    if (url.pathname === "/me/animelist") {
      const status = url.searchParams.get("status");
      const ids = [...linkedList].filter(([, s]) => !status || s === status).map(([id]) => id);
      return send(200, { data: ids.map(listItem) });
    }
    const entry = /^\/me\/animelist\/(\d+)$/.exec(url.pathname);
    if (entry && req.method === "PATCH") {
      const id = Number(entry[1]);
      linkedList.set(id, (await body(req)).status);
      return send(200, { status: linkedList.get(id), score: 0, num_episodes_watched: 0 });
    }
    if (entry && req.method === "DELETE") {
      linkedList.delete(Number(entry[1]));
      return send(204);
    }
  }
  if (await handleWatch(req, res, { url, send, error, body, authed })) return;
  if (url.pathname === "/me") {
    if (!authed) return send(401, error("not_authenticated"));
    if (req.method === "PATCH") {
      const patch = await body(req);
      if ("subtitle_lang" in patch) subtitleLang = patch.subtitle_lang;
    }
    return send(200, {
      id: "1",
      username: "kafka",
      locale: "en",
      show_nsfw: false,
      subtitle_lang: subtitleLang,
      is_admin: false,
      avatar: { kind: "none", version: 0 },
      share_activity: true,
    });
  }
  if (url.pathname === "/me/sessions" || url.pathname.startsWith("/me/sessions/")) {
    if (!authed) return send(401, error("not_authenticated"));
    if (req.method === "DELETE") {
      const id = url.pathname.split("/")[3];
      if (!id) otherSessions.clear();
      else if (!otherSessions.delete(id)) return send(404, error("session_not_found"));
      return send(204);
    }
    const now = new Date().toISOString();
    return send(200, [
      { id: "current", user_agent: "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0", ip: "10.0.0.1", started_at: now, last_active_at: now, current: true },
      ...[...otherSessions].map((id) => ({
        id,
        user_agent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Safari/604.1",
        ip: null,
        started_at: now,
        last_active_at: now,
        current: false,
      })),
    ]);
  }
  if (url.pathname === "/me/password" && req.method === "POST") {
    if (!authed) return send(401, error("not_authenticated"));
    const { current_password } = await body(req);
    return current_password === "password123" ? send(204) : send(403, error("wrong_password"));
  }
  if (url.pathname === "/me/mal") {
    const token = req.headers.authorization?.replace("Bearer ", "");
    if (!token || !accessTokens.has(token)) return send(401, error("not_authenticated"));
    return send(200, { connected: token.includes("expired") || token.includes("linked") });
  }
  if (url.pathname === "/me/animelist") {
    const token = req.headers.authorization?.replace("Bearer ", "");
    if (!token || !accessTokens.has(token)) return send(401, error("not_authenticated"));
    return send(401, error("mal_session_expired"));
  }
  if (url.pathname.startsWith("/anime/") || url.pathname === "/home") {
    const token = req.headers.authorization?.replace("Bearer ", "");
    if (!token || !accessTokens.has(token)) return send(401, error("not_authenticated"));
    if (url.pathname === "/home") return send(200, HOME);
    // Every title but the tracking-only one (id 2) has the stub source.
    const sources = /^\/anime\/(\d+)\/sources$/.exec(url.pathname);
    if (sources) {
      const id = Number(sources[1]);
      return send(200, id === 2 ? { sources: [], choice: null } : { sources: ["stub"], choice: choiceFor(id) });
    }
    if (url.pathname === "/anime/genres") return send(200, GENRES);
    if (url.pathname === "/anime/search") {
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      return send(200, { data: CATALOG.filter((a) => a.title.toLowerCase().includes(q)) });
    }
    if (url.pathname === "/anime/browse") {
      const genre = Number(url.searchParams.get("genre"));
      const data = genre ? CATALOG.filter((a) => a.genres.some((g) => g.id === genre)) : CATALOG;
      return send(200, { data, page: 1, has_next: false });
    }
  }
  send(404, error("not_found"));
}).listen(PORT, () => console.log(`fake api on ${PORT}`));
