import type { components } from "@app/api-client";
import { getTranslations } from "next-intl/server";

import { CoverCard } from "@/components/manga/CoverCard";
import { PosterCard } from "@/components/ui/PosterCard";
import { Row } from "@/components/ui/Row";
import { coverOf, mangaCaption, mangaHref, readFraction } from "@/lib/manga";

type Rows = components["schemas"]["MangaHomeOut"]["rows"];

/** The manga home rows: what the user is reading, then the rankings. The API leaves out empty ones. */
export async function MangaRows({ rows }: { rows: Rows }) {
  const t = await getTranslations("manga");
  return (
    <div className="space-y-10 py-8">
      {rows.map((row) => (
        <Row key={row.id} title={t(`rows.${row.id}`)} itemClassName={row.id === "top" ? "w-auto" : undefined}>
          {row.items.map(({ manga, progress }, i) =>
            row.id === "continue_reading" ? (
              <CoverCard
                key={manga.id}
                href={mangaHref(manga.id)}
                title={manga.title}
                image={coverOf(manga)}
                caption={progress ? t("chapterShort", { n: progress.chapter }) : undefined}
                progress={progress ? readFraction(progress) : undefined}
                seed={manga.id}
              />
            ) : row.id === "top" ? (
              <div key={manga.id} className="flex items-start">
                {/* As tall as the cover, so the numeral sits on its bottom edge whatever the caption. */}
                <span aria-hidden="true" className="-mr-3 flex h-48 items-end font-display text-[6.5rem] leading-[0.75] tracking-[-0.04em] text-numeral select-none sm:h-60">
                  {i + 1}
                </span>
                <div className="relative w-32 sm:w-40">
                  <PosterCard href={mangaHref(manga.id)} title={manga.title} image={coverOf(manga)} caption={mangaCaption(manga)} seed={manga.id} />
                </div>
              </div>
            ) : (
              <PosterCard key={manga.id} href={mangaHref(manga.id)} title={manga.title} image={coverOf(manga)} caption={mangaCaption(manga)} seed={manga.id} />
            ),
          )}
        </Row>
      ))}
    </div>
  );
}
