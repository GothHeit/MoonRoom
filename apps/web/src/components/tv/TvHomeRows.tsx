import { getTranslations } from "next-intl/server";

import { animeHref, captionOf, posterOf, progressFraction, watchHref, type HomeOut } from "@/lib/catalog";
import { genreName } from "@/lib/genres";

import { TvPosterCard, TvRankedCard, TvWideCard } from "./TvCards";
import { TvRow } from "./TvRow";
import { tvHref } from "./paths";

// A TV chip lays out every card it is given: keep the page to what fits a few presses.
const MAX_ROWS = 8;
const MAX_ITEMS = 20;

export async function TvHomeRows({ rows }: { rows: HomeOut["rows"] }) {
  const t = await getTranslations("home");
  const tGenres = await getTranslations("genres");
  const titleOf = (row: HomeOut["rows"][number]) => {
    if (row.genre) return t("rows.genre", { genre: genreName(tGenres, row.genre) });
    if (row.about) return t("rows.similar", { title: row.about.title });
    return t(`rows.${row.id}`);
  };
  return (
    <div className="space-y-4 pt-6">
      {rows.slice(0, MAX_ROWS).map((row) => {
        const key = row.genre ? `genre-${row.genre.id}` : row.about ? `similar-${row.about.id}` : row.id;
        return (
          <TvRow key={key} title={titleOf(row)} focusKey={`row-${key}`}>
            {row.items.slice(0, MAX_ITEMS).map(({ anime, progress, resume_episode }, i) => {
              const focusKey = `row-${key}-${anime.id}`;
              if (row.id === "continue_watching") {
                return (
                  <TvWideCard
                    key={anime.id}
                    focusKey={focusKey}
                    href={tvHref(resume_episode ? watchHref(anime.id, resume_episode) : animeHref(anime.id))}
                    title={anime.title}
                    image={posterOf(anime)}
                    caption={resume_episode ? t("episodeShort", { n: resume_episode }) : undefined}
                    progress={progress ? progressFraction(progress) : undefined}
                  />
                );
              }
              const card = { focusKey, href: tvHref(animeHref(anime.id)), title: anime.title, image: posterOf(anime), caption: captionOf(anime) };
              return row.id === "top" ? <TvRankedCard key={anime.id} rank={i + 1} {...card} /> : <TvPosterCard key={anime.id} {...card} />;
            })}
          </TvRow>
        );
      })}
    </div>
  );
}
