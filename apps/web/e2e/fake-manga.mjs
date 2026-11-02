// The manga side of the fake API: a small catalog, one source with chapters and page pictures.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PAGES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "pages");

const cover = (id, title, mediaType = "manga", extra = {}) => ({
  id,
  title,
  mean: 8.7,
  media_type: mediaType,
  status: "currently_publishing",
  num_chapters: null,
  num_volumes: 12,
  start_date: "2020-04-28",
  genres: [{ id: 2, name: "Adventure" }, { id: 10, name: "Fantasy" }],
  ...extra,
});

export const MANGA = [
  cover(1, "Sousou no Frieren", "manga", { alternative_titles: { en: "Frieren: Beyond Journey's End", ja: "葬送のフリーレン", synonyms: [] } }),
  cover(2, "Solo Leveling", "manhwa"),
  cover(3, "Vagabond", "manga", { status: "on_hiatus", num_chapters: 327 }),
  cover(4, "Dungeon Meshi", "manga", { status: "finished", num_chapters: 97 }),
];

// The user is partway through chapter 2 of title 1. Reading moves it; /manga/__reset puts it back.
const initialProgress = () => new Map([["1:2", { manga_id: 1, chapter: "2", page: 1, pages: 4, completed: false, updated_at: "2026-01-01T00:00:00Z" }]]);
let progress = initialProgress();

const chapter = (id, number, title, lang = "en") => ({
  id,
  number,
  volume: Number(number) <= 2 ? "1" : "2",
  title,
  lang,
  group: "Moon Scans",
  published_at: `2025-0${number}-01T00:00:00Z`,
  pages: 4,
});

const chaptersFor = (lang) =>
  lang === "pt-br"
    ? [chapter("p1", "1", "O fim da jornada", "pt-br")]
    : [chapter("c1", "1", "The Journey's End"), chapter("c2", "2", "The Priest's Lie"), chapter("c3", "3", "Blue-Moon Weed")];

const pageLinks = (chapterId) => [1, 2, 3, 4].map((n) => `/manga/page?u=${chapterId}-${n}&v=u&i=s&e=9999999999&s=sig&k=img`);

export function handleManga(url, req, send, res, body) {
  const path = url.pathname;
  if (path === "/manga/__reset") {
    progress = initialProgress();
    return send(204);
  }
  if (path === "/manga/home") {
    const reading = [...progress.values()].map((p) => ({ manga: MANGA.find((m) => m.id === p.manga_id), progress: p }));
    return send(200, {
      rows: [
        ...(reading.length ? [{ id: "continue_reading", items: reading }] : []),
        { id: "top", items: MANGA.map((manga) => ({ manga })) },
        { id: "popular", items: [...MANGA].reverse().map((manga) => ({ manga })) },
        { id: "manhwa", items: [{ manga: MANGA[1] }] },
      ],
    });
  }
  if (path === "/manga/search") {
    const q = (url.searchParams.get("q") ?? "").toLowerCase();
    return send(200, { data: MANGA.filter((m) => m.title.toLowerCase().includes(q)) });
  }
  if (path === "/manga/browse") {
    const row = url.searchParams.get("row") ?? "top";
    return send(200, { data: row === "manhwa" ? [MANGA[1]] : MANGA, page: 1, has_next: false });
  }
  if (path === "/manga/page") {
    const n = Number(url.searchParams.get("u")?.split("-").pop() ?? 1);
    res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "private, max-age=60" });
    return res.end(readFileSync(join(PAGES_DIR, `${((n - 1) % 4) + 1}.png`)));
  }
  const details = /^\/manga\/(\d+)$/.exec(path);
  if (details) {
    const manga = MANGA.find((m) => m.id === Number(details[1]));
    if (!manga) return send(404, { error: { code: "manga_not_found", message: "no" } });
    return send(200, {
      ...manga,
      synopsis: "After the hero's party defeats the Demon King, the elf mage Frieren sets out to understand the humans she outlived. [Written by MAL Rewrite]",
      authors: [{ first_name: "Kanehito", last_name: "Yamada" }, { first_name: "Tsukasa", last_name: "Abe" }],
      related_manga: manga.id === 1 ? [{ relation_type: "side_story", relation_type_formatted: "Side story", manga: MANGA[3] }] : [],
      recommendations: manga.id === 1 ? [{ manga: MANGA[2], num_recommendations: 3 }] : [],
    });
  }
  const chapters = /^\/manga\/(\d+)\/chapters$/.exec(path);
  if (chapters) {
    const id = Number(chapters[1]);
    // Title 3 is in the catalog only.
    if (id === 3) return send(404, { error: { code: "not_available", message: "no" } });
    const lang = url.searchParams.get("lang") ?? "en";
    const saved = {};
    for (const p of progress.values()) if (p.manga_id === id) saved[p.chapter] = p;
    return send(200, { source: "stub", source_id: "md-1", source_title: "Frieren", lang, languages: ["pt-br", "en"], chapters: chaptersFor(lang), progress: saved });
  }
  const read = /^\/manga\/(\d+)\/read\/stub\/([^/]+)$/.exec(path);
  if (read) {
    const id = Number(read[1]);
    const list = chaptersFor(url.searchParams.get("lang") ?? "en");
    const index = list.findIndex((c) => c.id === read[2]);
    if (index < 0) return send(404, { error: { code: "not_available", message: "no" } });
    const current = list[index];
    return send(200, {
      source: "stub",
      chapter: current,
      pages: pageLinks(current.id),
      previous: list[index - 1] ?? null,
      next: list[index + 1] ?? null,
      progress: progress.get(`${id}:${current.number}`) ?? null,
    });
  }
  const put = /^\/manga\/(\d+)\/progress\/([^/]+)$/.exec(path);
  if (put && req.method === "PUT") {
    return body(req).then((data) => {
      const row = { manga_id: Number(put[1]), chapter: decodeURIComponent(put[2]), ...data, completed: data.completed || data.page >= data.pages - 1, updated_at: "2026-01-01T00:00:00Z" };
      progress.set(`${row.manga_id}:${row.chapter}`, row);
      return send(200, row);
    });
  }
  return false;
}
