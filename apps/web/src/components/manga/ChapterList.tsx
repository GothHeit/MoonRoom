"use client";

import { useFormatter, useTranslations } from "next-intl";

import { Link, useRouter } from "@/i18n/navigation";
import { languageName, progressKey, readHref, type Chapter, type ChaptersOut } from "@/lib/manga";

type Props = {
  mangaId: number;
  listing: ChaptersOut;
};

/** "Ch. 12", "Vol. 2 · Ch. 12" or "One-shot". */
export function chapterLabel(t: (key: string, values?: Record<string, string>) => string, chapter: Chapter) {
  if (!chapter.number) return t("oneShot");
  return t("chapter", { n: chapter.number });
}

/**
 * The chapter list of the title page: a language menu and one text row per chapter (newest
 * first, read ones dimmed). Every chapter is a link to the reader.
 */
export function ChapterList({ mangaId, listing }: Props) {
  const t = useTranslations("manga.page");
  const format = useFormatter();
  const router = useRouter();
  const { source, source_title, lang, languages = [], chapters = [], progress = {} } = listing;
  const latest = chapters[chapters.length - 1];

  return (
    <section aria-labelledby="chapters" className="px-4 sm:px-8">
      <h2 id="chapters" className="mb-3 flex items-baseline gap-3 text-2xl sm:text-[1.75rem]">
        {t("chapterList")}
        <span className="font-sans text-sm text-muted">{chapters.length}</span>
      </h2>
      <div className="mb-2 flex flex-wrap items-center gap-3">
        {languages.length > 1 && (
          <label className="flex items-center gap-2 text-sm text-muted">
            <span className="sr-only">{t("language")}</span>
            <select
              aria-label={t("language")}
              value={lang ?? ""}
              onChange={(e) => router.replace({ pathname: `/manga/${mangaId}`, query: { lang: e.target.value } })}
              className="h-11 rounded-full border border-line-strong bg-bg px-4 text-sm text-fg focus:border-accent"
            >
              {languages.map((code) => (
                <option key={code} value={code}>
                  {languageName(code)}
                </option>
              ))}
            </select>
          </label>
        )}
        <span className="text-sm text-muted">{t("from", { source: source_title })}</span>
      </div>
      {chapters.length === 0 ? (
        <p className="py-6 text-muted">{t("noChapters")}</p>
      ) : (
        <ol reversed className="divide-y divide-line">
          {[...chapters].reverse().map((chapter) => {
            const p = progress[progressKey(chapter)];
            const read = !!p?.completed;
            const date = chapter.published_at ? new Date(chapter.published_at) : null;
            const status = read ? t("read") : p ? t("pageOf", { page: p.page + 1, pages: p.pages }) : null;
            return (
              <li key={chapter.id}>
                <Link
                  href={readHref(source, mangaId, chapter.id, lang)}
                  className={`press flex min-h-14 items-center gap-4 py-2 hover:text-accent ${read ? "text-muted" : ""}`}
                >
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-2">
                      <span className="shrink-0 font-bold">{chapterLabel(t, chapter)}</span>
                      {chapter.title && <span className="truncate text-sm text-soft">{chapter.title}</span>}
                      {chapter === latest && !read && (
                        <span className="shrink-0 rounded-full border border-accent px-2 py-0.5 text-[11px] font-bold text-accent">
                          {t("latest")}
                        </span>
                      )}
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-muted">
                      {[chapter.volume ? t("volume", { n: chapter.volume }) : null, chapter.group].filter(Boolean).join(" · ")}
                    </span>
                  </span>
                  <span className="shrink-0 text-right text-xs text-muted">
                    {status && <span className={`block ${read ? "" : "text-accent"}`}>{status}</span>}
                    {date && !Number.isNaN(date.getTime()) && (
                      <time dateTime={chapter.published_at ?? undefined}>{format.dateTime(date, { dateStyle: "medium" })}</time>
                    )}
                  </span>
                </Link>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
