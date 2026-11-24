// Comments (on titles, episodes and chapters, with replies and reactions) and friends' progress
// for the fake API. Anime 1 and manga 1 start with a few comments and friends; everything else
// starts empty. /comments/__reset puts them back. The viewer has "finished" episodes 1 and 2 of
// every anime and chapters up to 111 of every manga; later ones are locked.
const ME = "1";
const person = (id, username, preset = null) => ({
  id,
  username,
  avatar: preset ? { kind: "preset", preset, version: 0 } : { kind: "none", version: 0 },
});
const PEOPLE = {
  me: person(ME, "kafka", "moon-1"),
  junior: person("00000000-0000-4000-8000-00000000000a", "junior", "moon-3"),
  pondofe: person("00000000-0000-4000-8000-00000000000b", "pondofe"),
  claudia: person("00000000-0000-4000-8000-00000000000c", "claudia", "moon-6"),
  marina: person("00000000-0000-4000-8000-00000000000d", "marina"),
};
const ago = (hours) => new Date(Date.now() - hours * 3600_000).toISOString();

let comments;
let counter;
let reactions;
function reset() {
  counter = 0;
  reactions = [];
  const seed = (key, user, body, hours, extra = {}) => ({
    key,
    id: `c-${++counter}`,
    user,
    body,
    spoiler: false,
    created_at: ago(hours),
    edited_at: null,
    ...extra,
  });
  comments = [
    seed("anime:1", PEOPLE.me, "Himmel being right about everything years later hits harder every time.", 72, { edited_at: ago(60) }),
    seed("anime:1", PEOPLE.claudia, "Took me a few episodes to get into it, now I can't stop.", 50),
    seed("anime:1", PEOPLE.pondofe, "The ending of episode 3 broke me.", 24, { spoiler: true }),
    seed("anime:1", PEOPLE.junior, "The pacing in the second half is unreal. Episode 10 alone made me rewatch the whole fight twice.", 2),
    seed("manga:1", PEOPLE.junior, "The art in the later volumes is something else.", 5),
    seed("anime:1:e2", PEOPLE.me, "That ending. I did NOT expect Himmel's statue to come back like that.", 2),
    seed("anime:1:e2", PEOPLE.pondofe, "The fight felt slower than the manga, but the quiet parts were perfect.", 0.7),
    seed("anime:1:e2", PEOPLE.junior, "Fern carrying the whole episode again.", 26, { spoiler: true }),
    seed("anime:1:e3", PEOPLE.junior, "No way.", 1),
    seed("anime:1:e3", PEOPLE.pondofe, "I need the next one now.", 3),
    seed("manga:1:c1", PEOPLE.junior, "That last page.", 2),
  ];
  const first = comments.find((c) => c.key === "anime:1:e2" && c.user === PEOPLE.me);
  comments.push(
    { ...seed("anime:1:e2", PEOPLE.junior, "Same, I paused it for a whole minute", 0.2), parent: first.id },
    { ...seed("anime:1:e2", PEOPLE.claudia, "the music in that scene too", 0.05), parent: first.id },
    { ...seed("anime:1:e2", PEOPLE.marina, "I cried", 0.04), parent: first.id },
  );
  const react = (id, user, kind) => reactions.push({ id, user: user.id, kind });
  react(first.id, PEOPLE.me, "heart");
  react(first.id, PEOPLE.junior, "heart");
  react(first.id, PEOPLE.claudia, "heart");
  react(first.id, PEOPLE.junior, "cry");
  react(first.id, PEOPLE.pondofe, "cry");
  const second = comments.find((c) => c.key === "anime:1:e2" && c.user === PEOPLE.pondofe);
  react(second.id, PEOPLE.junior, "fire");
  react(second.id, PEOPLE.claudia, "fire");
}

const KINDS = ["heart", "laugh", "wow", "cry", "fire", "clap"];
function reactionsOf(id) {
  return KINDS.flatMap((kind) => {
    const mine = reactions.filter((r) => r.id === id && r.kind === kind);
    return mine.length ? [{ kind, count: mine.length, mine: mine.some((r) => r.user === ME) }] : [];
  });
}
reset();

const FRIENDS = {
  "anime:1": [
    { user: PEOPLE.junior, episode: 2, completed: false, at: ago(1) },
    { user: PEOPLE.pondofe, episode: 3, completed: true, at: ago(20) },
    { user: PEOPLE.claudia, episode: 1, completed: true, at: ago(40) },
    { user: PEOPLE.marina, episode: 1, completed: false, at: ago(90) },
  ],
  "manga:1": [{ user: PEOPLE.junior, chapter: "112", completed: false, at: ago(3) }],
};

const out = (c) => ({
  id: c.id,
  user: c.user,
  body: c.body,
  spoiler: c.spoiler,
  created_at: c.created_at,
  edited_at: c.edited_at,
  mine: c.user.id === ME,
  reactions: reactionsOf(c.id),
  replies: c.parent
    ? []
    : comments
        .filter((r) => r.parent === c.id)
        .sort((a, b) => a.created_at.localeCompare(b.created_at))
        .map(out),
});

function unlocked(key) {
  const part = /:(e|c)([\d.]+)$/.exec(key);
  if (!part) return true;
  return part[1] === "e" ? Number(part[2]) <= 2 : Number(part[2]) <= 111;
}

function clean(text) {
  return String(text ?? "").trim();
}

/** Handles the request when it is about comments or friends on a title; returns false otherwise. */
export async function handleComments(req, url, { send, error, body, authed }) {
  if (url.pathname === "/comments/__reset") {
    reset();
    return send(204);
  }
  const part = /^\/(?:anime\/(\d+)\/episodes\/(\d+)|manga\/(\d+)\/chapters\/([^/]+))\/comments$/.exec(url.pathname);
  const title = /^\/(anime|manga)\/(\d+)\/(comments|friends)$/.exec(url.pathname);
  const one = /^\/comments\/([\w-]+)$/.exec(url.pathname);
  const replies = /^\/comments\/([\w-]+)\/replies$/.exec(url.pathname);
  const reaction = /^\/comments\/([\w-]+)\/reactions\/(\w+)$/.exec(url.pathname);
  if (!part && !title && !one && !replies && !reaction) return false;
  if (!authed) return send(401, error("not_authenticated"));

  if (part) {
    const key = part[1] ? `anime:${part[1]}:e${part[2]}` : `manga:${part[3]}:c${decodeURIComponent(part[4])}`;
    const open = unlocked(key);
    if (req.method === "POST") {
      if (!open) return send(403, error("comments_locked"));
      const { body: text, spoiler } = await body(req);
      if (!clean(text)) return send(422, error("comment_empty"));
      const c = { key, id: `c-${++counter}`, user: PEOPLE.me, body: clean(text), spoiler: !!spoiler, created_at: new Date().toISOString(), edited_at: null };
      comments.push(c);
      return send(201, out(c));
    }
    const all = comments.filter((c) => c.key === key && !c.parent).sort((a, b) => b.created_at.localeCompare(a.created_at));
    const people = [...new Map(all.map((c) => [c.user.id, c.user])).values()].slice(0, 3);
    if (!open) return send(200, { items: [], total: all.length, next: null, locked: true, people });
    const limit = Number(url.searchParams.get("limit") ?? 20);
    return send(200, { items: all.slice(0, limit).map(out), total: all.length, next: null, locked: false, people });
  }

  if (replies) {
    const parent = comments.find((x) => x.id === replies[1]);
    if (!parent || !unlocked(parent.key)) return send(404, error("comment_not_found"));
    const { body: text } = await body(req);
    if (!clean(text)) return send(422, error("comment_empty"));
    const top = parent.parent ? parent.parent : parent.id;
    const c = { key: parent.key, id: `c-${++counter}`, user: PEOPLE.me, body: clean(text), spoiler: false, created_at: new Date().toISOString(), edited_at: null, parent: top };
    comments.push(c);
    return send(201, out(c));
  }

  if (reaction) {
    const target = comments.find((x) => x.id === reaction[1]);
    if (!target || !unlocked(target.key)) return send(404, error("comment_not_found"));
    if (!KINDS.includes(reaction[2])) return send(422, error("validation_failed"));
    reactions = reactions.filter((r) => !(r.id === target.id && r.user === ME && r.kind === reaction[2]));
    if (req.method === "PUT") reactions.push({ id: target.id, user: ME, kind: reaction[2] });
    return send(200, reactionsOf(target.id));
  }

  if (title) {
    const key = `${title[1]}:${title[2]}`;
    if (title[3] === "friends") return send(200, FRIENDS[key] ?? []);
    if (req.method === "POST") {
      const { body: text, spoiler } = await body(req);
      if (!clean(text)) return send(422, error("comment_empty"));
      const c = { key, id: `c-${++counter}`, user: PEOPLE.me, body: clean(text), spoiler: !!spoiler, created_at: new Date().toISOString(), edited_at: null };
      comments.push(c);
      return send(201, out(c));
    }
    const all = comments.filter((c) => c.key === key && !c.parent).sort((a, b) => b.created_at.localeCompare(a.created_at));
    const before = url.searchParams.get("before");
    const limit = Number(url.searchParams.get("limit") ?? 3);
    // Like the API, the cursor is a position (time and id), so it outlives the comment it came from.
    const key_ = (c) => `${c.created_at}_${c.id}`;
    const after = before ? all.filter((c) => key_(c) < before) : all;
    const page = after.slice(0, limit);
    const next = after.length > limit ? key_(page[page.length - 1]) : null;
    return send(200, { items: page.map(out), total: all.length, next });
  }

  const c = comments.find((x) => x.id === one[1] && x.user.id === ME);
  if (!c) return send(404, error("comment_not_found"));
  if (req.method === "DELETE") {
    comments = comments.filter((x) => x !== c && x.parent !== c.id);
    return send(204);
  }
  if (req.method === "PATCH") {
    const patch = await body(req);
    if (patch.body != null) {
      if (!clean(patch.body)) return send(422, error("comment_empty"));
      if (clean(patch.body) !== c.body) c.edited_at = new Date().toISOString();
      c.body = clean(patch.body);
    }
    if (patch.spoiler != null) c.spoiler = patch.spoiler;
    return send(200, out(c));
  }
  return send(405, error("method_not_allowed"));
}
