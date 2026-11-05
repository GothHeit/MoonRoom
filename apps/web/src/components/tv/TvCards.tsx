import { placeholderFor } from "@/components/ui/PosterCard";

import { TvLink } from "./TvLink";

// The focused card grows to 1.06 with a 3px lilac ring; its title brightens from soft to text.
const ART =
  "relative overflow-hidden rounded-ui outline-[3px] outline-offset-4 outline-solid outline-transparent transition-transform duration-[160ms] ease-out group-data-[focused=true]:scale-[1.06] group-data-[focused=true]:outline-accent";
const TITLE = "text-[1.75rem] font-bold leading-tight text-soft group-data-[focused=true]:text-fg";

type Poster = {
  href: string;
  title: string;
  image?: string | null;
  caption?: string;
  seed?: string | number;
  focusKey?: string;
  className?: string;
};

/** A 2:3 poster for rows and grids. */
export function TvPosterCard({ href, title, image, caption, seed = title, focusKey, className = "w-60 shrink-0" }: Poster) {
  return (
    <TvLink href={href} focusKey={focusKey} label={caption ? `${title}, ${caption}` : title} className={className}>
      <div className={`${ART} aspect-[2/3] ${placeholderFor(seed)}`}>
        {image && (
          // eslint-disable-next-line @next/next/no-img-element -- posters come from remote catalogs
          <img src={image} alt="" width={240} height={360} loading="lazy" decoding="async" className="absolute inset-0 h-full w-full object-cover" />
        )}
      </div>
      <p className={`mt-4 line-clamp-2 ${TITLE}`}>{title}</p>
      {caption && <p className="mt-1 text-[1.5rem] text-muted">{caption}</p>}
    </TvLink>
  );
}

type Wide = Poster & { progress?: number };

/** A 16:9 card with a progress bar, for Continue watching and episodes. */
export function TvWideCard({ href, title, image, caption, progress, seed = title, focusKey, className = "w-[26rem] shrink-0" }: Wide) {
  const pct = progress === undefined ? undefined : Math.round(Math.min(Math.max(progress, 0), 1) * 100);
  return (
    <TvLink href={href} focusKey={focusKey} label={caption ? `${title}, ${caption}` : title} className={className}>
      <div className={`${ART} aspect-video ${placeholderFor(seed)}`}>
        {image && (
          // eslint-disable-next-line @next/next/no-img-element -- thumbnails come from remote catalogs
          <img src={image} alt="" width={416} height={234} loading="lazy" decoding="async" className="absolute inset-0 h-full w-full object-cover" />
        )}
        {pct !== undefined && (
          <div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={title} className="absolute inset-x-0 bottom-0 h-1.5 bg-line">
            <div className="h-full bg-accent" style={{ width: `${pct}%` }} />
          </div>
        )}
      </div>
      {/* "Title · Ep 4": the episode stays visible when a long title is cut. */}
      <p className={`mt-4 flex min-w-0 ${TITLE}`}>
        <span className="truncate">{title}</span>
        {caption && <span className="shrink-0 whitespace-pre text-muted">{` · ${caption}`}</span>}
      </p>
    </TvLink>
  );
}

/** A poster leaning on a big serif rank numeral, for the top-ranked row. */
export function TvRankedCard({ rank, ...poster }: Poster & { rank: number }) {
  return (
    <div className="flex shrink-0 items-start">
      <span aria-hidden="true" className="mr-2 flex h-[22.5rem] items-end font-display text-[11rem] leading-[0.75] tracking-[-0.04em] text-numeral select-none">
        {rank}
      </span>
      <TvPosterCard {...poster} />
    </div>
  );
}
