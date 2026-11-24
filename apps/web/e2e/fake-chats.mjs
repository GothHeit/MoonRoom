// Messages for the fake API: friends, a direct chat with junior (with a shared episode), a group
// and a direct chat with claudia that is muted. /chats/__reset puts them back. Live events are an
// open stream that only sends what this process publishes after a POST.
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
};
const FRIENDS = [PEOPLE.junior, PEOPLE.pondofe, PEOPLE.claudia];
const ago = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
const CHAT = {
  junior: "10000000-0000-4000-8000-000000000001",
  group: "10000000-0000-4000-8000-000000000002",
  claudia: "10000000-0000-4000-8000-000000000003",
};

let chats;
let messages;
let counter;
const streams = new Set();

function reset() {
  counter = 0;
  chats = [
    { id: CHAT.junior, kind: "direct", name: null, members: [PEOPLE.me, PEOPLE.junior], muted: false, read: { [ME]: ago(3.5), [PEOPLE.junior.id]: ago(1) } },
    { id: CHAT.group, kind: "group", name: "Saturday anime", members: [PEOPLE.me, PEOPLE.pondofe, PEOPLE.claudia], muted: false, read: { [ME]: ago(5) } },
    { id: CHAT.claudia, kind: "direct", name: null, members: [PEOPLE.me, PEOPLE.claudia], muted: true, read: { [ME]: ago(0) } },
  ];
  const frieren = { kind: "anime", id: 1, episode: 4, chapter: null, title: "Frieren", image: null, poster: null, hidden: false };
  const dandadan = { kind: "manga", id: 1, episode: null, chapter: "112", title: "Dandadan", image: null, poster: null, hidden: false };
  const m = (chat, user, body, minutes, share = null) => ({ id: `m-${++counter}`, chat_id: chat, user, body, share, created_at: ago(minutes) });
  messages = [
    m(CHAT.claudia, PEOPLE.me, "ok starting tonight", 3 * 24 * 60),
    m(CHAT.junior, PEOPLE.junior, "did you finish the first arc?", 26 * 60),
    m(CHAT.junior, PEOPLE.me, "not yet, I stopped at ep 3", 25 * 60),
    m(CHAT.junior, PEOPLE.junior, "watch this one tonight, the fight is unreal", 4, frieren),
    m(CHAT.junior, PEOPLE.me, "ok starting after dinner", 3),
    m(CHAT.junior, PEOPLE.me, "tell me when you get to the end 👀", 2.5),
    m(CHAT.group, PEOPLE.pondofe, "who is in for saturday?", 40),
    m(CHAT.group, PEOPLE.claudia, "me, but after 9", 35),
    m(CHAT.group, PEOPLE.pondofe, "let's do the next two", 20, dandadan),
    m(CHAT.group, PEOPLE.me, "room link at 9 then", 12),
    m(CHAT.group, PEOPLE.pondofe, "ep 9 was insane", 2),
  ];
}
reset();

const sorted = (list) => [...list].sort((a, b) => a.created_at.localeCompare(b.created_at));
const lastOf = (chat) => sorted(messages.filter((x) => x.chat_id === chat.id)).at(-1);
const outMessage = (x) => ({ ...x, mine: x.user.id === ME });
function outChat(chat) {
  const last = lastOf(chat);
  const others = chat.members.filter((p) => p.id !== ME);
  const readMe = chat.read[ME] ?? "";
  const unread = messages.filter((x) => x.chat_id === chat.id && x.user.id !== ME && x.created_at > readMe).length;
  return {
    id: chat.id,
    kind: chat.kind,
    name: chat.name,
    members: others,
    muted: chat.muted,
    unread,
    last: last ? outMessage(last) : null,
    last_message_at: last?.created_at ?? ago(0),
    can_send: true,
    read_at: chat.kind === "direct" ? (chat.read[others[0].id] ?? null) : null,
  };
}

function publish(kind, data) {
  for (const res of streams) res.write(`event: ${kind}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** Handles the request when it is about friends or chats; returns false otherwise. */
export async function handleChats(req, res, url, { send, error, body, authed }) {
  if (url.pathname === "/chats/__reset") {
    reset();
    return send(204);
  }
  if (url.pathname !== "/friends" && !url.pathname.startsWith("/chats")) return false;
  if (!authed) return send(401, error("not_authenticated"));
  if (url.pathname === "/friends") return send(200, FRIENDS.map((user) => ({ user, since: ago(10_000) })));
  if (url.pathname === "/chats") {
    return send(200, { items: chats.map(outChat).sort((a, b) => b.last_message_at.localeCompare(a.last_message_at)) });
  }
  if (url.pathname === "/chats/unread") return send(200, { chats: chats.map(outChat).filter((c) => c.unread > 0 && !c.muted).length });
  if (url.pathname === "/chats/events") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    res.write("retry: 3000\n\n");
    streams.add(res);
    req.on("close", () => streams.delete(res));
    return true;
  }
  if (url.pathname === "/chats/share" && req.method === "POST") {
    const input = await body(req);
    const ids = [...(input.chat_ids ?? [])];
    for (const user of input.user_ids ?? []) {
      const found = chats.find((c) => c.kind === "direct" && c.members.some((p) => p.id === user));
      if (found) ids.push(found.id);
    }
    for (const id of ids) {
      const x = {
        id: `m-${++counter}`,
        chat_id: id,
        user: PEOPLE.me,
        body: input.body || null,
        share: { ...input.share, episode: input.share.episode ?? null, chapter: input.share.chapter ?? null, title: input.share.kind === "anime" ? "Frieren" : "Dandadan", image: null, poster: null, hidden: false },
        created_at: new Date().toISOString(),
      };
      messages.push(x);
      publish("message", outMessage(x));
    }
    return send(201, { chat_ids: ids });
  }
  const one = /^\/chats\/([\w-]+)(?:\/(messages|read|mute))?$/.exec(url.pathname);
  const chat = one && chats.find((c) => c.id === one[1]);
  if (!chat) return send(404, error("chat_not_found"));
  if (!one[2]) return send(200, outChat(chat));
  if (one[2] === "read") {
    chat.read[ME] = new Date().toISOString();
    return send(204);
  }
  if (one[2] === "mute") {
    chat.muted = (await body(req)).muted;
    return send(204);
  }
  if (req.method === "POST") {
    const input = await body(req);
    const text = (input.body ?? "").trim();
    if (!text && !input.share) return send(422, error("message_empty"));
    const x = { id: `m-${++counter}`, chat_id: chat.id, user: PEOPLE.me, body: text || null, share: null, created_at: new Date().toISOString() };
    messages.push(x);
    publish("message", outMessage(x));
    return send(201, outMessage(x));
  }
  return send(200, { items: sorted(messages.filter((x) => x.chat_id === chat.id)).map(outMessage), next: null });
}
