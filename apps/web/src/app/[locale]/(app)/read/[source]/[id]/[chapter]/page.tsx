import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { cache } from "react";

import { Reader } from "@/components/reader/Reader";
import { APP_NAME } from "@/lib/brand";
import { serverApi, unwrap } from "@/lib/server-api";

type Params = PageProps<"/[locale]/read/[source]/[id]/[chapter]">;

function parseId(raw: string) {
  const id = Number(raw);
  if (!Number.isInteger(id) || id < 1) notFound();
  return id;
}

const details = cache(async (id: number) => (await serverApi()).GET("/manga/{manga_id}", { params: { path: { manga_id: id } } }));

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { id, locale } = await params;
  const [{ data }, t] = await Promise.all([details(parseId(id)), getTranslations({ locale, namespace: "reader" })]);
  return { title: data ? `${data.title} · ${t("chapter", { n: "…" })} · ${APP_NAME}` : APP_NAME };
}

export default async function ReadPage({ params, searchParams }: Params) {
  const { locale, source, id: rawId, chapter } = await params;
  setRequestLocale(locale);
  const id = parseId(rawId);
  const rawLang = (await searchParams).lang;
  const lang = (Array.isArray(rawLang) ? rawLang[0] : rawLang)?.slice(0, 10) || undefined;
  const api = await serverApi();

  const [manga, pages] = await Promise.all([
    unwrap(details(id), locale),
    unwrap(
      api.GET("/manga/{manga_id}/read/{source}/{chapter_id}", {
        params: { path: { manga_id: id, source, chapter_id: chapter }, query: { lang } },
      }),
      locale,
    ),
  ]);
  const saved = pages.progress;
  const startPage = saved && !saved.completed ? saved.page : 0;

  return (
    <Reader
      key={`${source}-${id}-${chapter}`}
      mangaId={id}
      source={source}
      title={manga.title}
      mediaType={manga.media_type}
      chapter={pages.chapter}
      previous={pages.previous ?? null}
      next={pages.next ?? null}
      pages={pages.pages.map((link) => `/api/proxy${link}`)}
      startPage={startPage}
      lang={lang ?? pages.chapter.lang ?? null}
    />
  );
}
