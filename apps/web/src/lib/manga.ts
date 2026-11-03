import type { components } from "@app/api-client";

export type MangaCard = components["schemas"]["MangaCard"];
export type MangaDetails = components["schemas"]["MangaDetailsOut"];
export type Chapter = components["schemas"]["ChapterOut"];
export type ChaptersOut = components["schemas"]["ChaptersOut"];
export type MangaProgress = components["schemas"]["MangaProgressOut"];

export const MANGA_LIST_STATUSES = ["reading", "plan_to_read", "completed", "on_hold", "dropped"] as const;
export type MangaListStatus = (typeof MANGA_LIST_STATUSES)[number];
export type MangaListEntry = components["schemas"]["MangaListItemOut"];

export const mangaHref = (id: number) => `/manga/${id}`;

/** Opens a chapter in the reader. The language keeps the chapter list (and so "next") in the same translation. */
export function readHref(source: string, mangaId: number, chapterId: string, lang?: string | null) {
  const base = `/read/${encodeURIComponent(source)}/${mangaId}/${encodeURIComponent(chapterId)}`;
  return lang ? `${base}?lang=${encodeURIComponent(lang)}` : base;
}

export const coverOf = (card: MangaCard) => card.main_picture?.large ?? card.main_picture?.medium ?? null;

/** "2020 · ★ 8.4" with whatever the card knows. */
export function mangaCaption(card: MangaCard) {
  const parts: string[] = [];
  const year = card.start_date?.slice(0, 4);
  if (year) parts.push(year);
  if (card.mean) parts.push(`★ ${card.mean.toFixed(1)}`);
  return parts.join(" · ");
}

/** What progress in a chapter is filed under: its number, or its id for an unnumbered one (the API does the same). */
export const progressKey = (chapter: Pick<Chapter, "number" | "id">) => (chapter.number || chapter.id).slice(0, 16);

export type ReadMode = "page" | "strip";
export type Direction = "ltr" | "rtl";
export type ReadingSettings = { mode: ReadMode; direction: Direction };

// Korean and Chinese webtoons are drawn as one long column; Japanese manga is paged, right to left.
const STRIP_TYPES = new Set(["manhwa", "manhua", "oel"]);

/** How a title opens before the reader has been told otherwise. */
export function defaultReading(mediaType: string | null | undefined): ReadingSettings {
  return STRIP_TYPES.has(mediaType ?? "") ? { mode: "strip", direction: "ltr" } : { mode: "page", direction: "rtl" };
}

/** Fraction of the chapter read, 0 to 1. */
export function readFraction(p: Pick<MangaProgress, "page" | "pages" | "completed">) {
  if (p.completed) return 1;
  if (p.pages <= 1) return 0.02;
  return Math.max(0.02, Math.min(p.page / (p.pages - 1), 1));
}

/** The chapter to open from the title page: the one being read, else the first unread after the last finished one. */
export function nextChapter(chapters: Chapter[], progress: Record<string, MangaProgress>) {
  let lastDone = -1;
  for (let i = chapters.length - 1; i >= 0; i--) {
    const p = progress[progressKey(chapters[i])];
    if (p && !p.completed) return { chapter: chapters[i], resume: true };
    if (p?.completed && lastDone < 0) lastDone = i;
  }
  if (lastDone < 0) return chapters.length ? { chapter: chapters[0], resume: false } : null;
  const next = chapters[lastDone + 1];
  return next ? { chapter: next, resume: false } : null;
}

/** What the title page's primary pill says and opens, from the chapters and the user's progress. */
export function readAction(listing: ChaptersOut, mangaId: number) {
  const { source, lang, chapters = [], progress = {} } = listing;
  const up = nextChapter(chapters, progress);
  if (!up) return null;
  const n = up.chapter.number || "–";
  const key = up.resume ? "continue" : progress[progressKey(up.chapter)] ? "readAgain" : up.chapter === chapters[0] ? "start" : "next";
  return { href: readHref(source, mangaId, up.chapter.id, lang), key, n } as const;
}

/** The language names shown in the chapter language menu; others show their code. */
export const LANGUAGE_NAMES: Record<string, string> = {
  "pt-br": "Português (BR)",
  pt: "Português",
  en: "English",
  es: "Español",
  "es-la": "Español (LATAM)",
  fr: "Français",
  de: "Deutsch",
  it: "Italiano",
  ja: "日本語",
  ko: "한국어",
  "zh-hk": "中文 (HK)",
  zh: "中文",
  ru: "Русский",
  id: "Bahasa Indonesia",
  vi: "Tiếng Việt",
  th: "ไทย",
  tr: "Türkçe",
  pl: "Polski",
  ar: "العربية",
  uk: "Українська",
};

export const languageName = (code: string) => LANGUAGE_NAMES[code] ?? code.toUpperCase();

const SOURCE_NAMES: Record<string, string> = {
  mangadex: "MangaDex",
  mangapill: "MangaPill",
  mangalivre: "MangaLivre",
  toonbr: "ToonBR",
  teca: "Teca",
  leituramanga: "Leitura Manga",
};

/** The source's display name; an unknown one shows as it is configured. */
export const sourceName = (name: string) => SOURCE_NAMES[name] ?? name;
