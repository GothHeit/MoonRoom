import { getTranslations } from "next-intl/server";

import { PosterCard } from "@/components/ui/PosterCard";
import { Row } from "@/components/ui/Row";
import { ContinueCard } from "./ContinueCard";
import { genreName } from "@/lib/genres";
import { animeHref, captionOf, watchHref, posterOf, progressFraction, type HomeOut } from "@/lib/catalog";

const WIDE = "w-64 sm:w-80";
// The ranked row: a big serif numeral stands beside each poster.
const RANKED = "w-auto";

/** The rows under the hero. The API already leaves out empty ones. */
export async function HomeRows({ rows }: { rows: HomeOut["rows"] }) {
  const t = await getTranslations("home");
  const tGenres = await getTranslations("genres");
  const titleOf = (row: HomeOut["rows"][number]) => {
    if (row.genre) return t("rows.genre", { genre: genreName(tGenres, row.genre) });
    if (row.about) return t("rows.similar", { title: row.about.title });
    return t(`rows.${row.id}`);
  };
  return (
    <div className="space-y-10 py-8">
      {rows.map((row) => (
        <Row
          key={row.genre ? `genre-${row.genre.id}` : row.id}
          title={titleOf(row)}
          itemClassName={row.id === "continue_watching" ? WIDE : row.id === "top" ? RANKED : undefined}
        >
          {row.items.map(({ anime, progress, resume_episode, from_mal }, i) =>
            row.id === "continue_watching" ? (
              <ContinueCard
                key={anime.id}
                animeId={anime.id}
                href={resume_episode ? watchHref(anime.id, resume_episode) : animeHref(anime.id)}
                title={anime.title}
                image={posterOf(anime)}
                caption={
                  resume_episode
                    ? [t("episodeShort", { n: resume_episode }), from_mal ? t("fromMal") : null].filter(Boolean).join(" · ")
                    : undefined
                }
                progress={progress ? progressFraction(progress) : undefined}
              />
            ) : row.id === "top" ? (
              <div key={anime.id} className="flex items-start">
                {/* As tall as the poster, so the numeral sits on its bottom edge whatever the caption. It keeps a
                    column of its own: the poster starts where the numeral ends and never covers it. */}
                <span aria-hidden="true" className="mr-2 flex h-48 items-end font-display text-[6.5rem] leading-[0.75] text-numeral select-none sm:mr-3 sm:h-60 sm:text-[8.5rem]">
                  {i + 1}
                </span>
                <div className="relative w-32 sm:w-40">
                  <PosterCard href={animeHref(anime.id)} title={anime.title} image={posterOf(anime)} caption={captionOf(anime)} />
                </div>
              </div>
            ) : (
              <PosterCard
                key={anime.id}
                href={animeHref(anime.id)}
                title={anime.title}
                image={posterOf(anime)}
                caption={captionOf(anime)}
              />
            ),
          )}
        </Row>
      ))}
    </div>
  );
}
