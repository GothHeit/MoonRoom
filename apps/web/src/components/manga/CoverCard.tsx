import { Link } from "@/i18n/navigation";

import { placeholderFor } from "@/components/ui/PosterCard";

type Props = {
  href: string;
  title: string;
  image?: string | null;
  /** "Ch. 12": on its own line under the title. */
  caption?: string;
  /** 0 to 1. Shows the progress bar when set. */
  progress?: number;
  seed?: string | number;
};

/** A 2:3 cover with a thin progress bar, for Continue reading. */
export function CoverCard({ href, title, image, caption, progress, seed = title }: Props) {
  const pct = progress === undefined ? undefined : Math.round(Math.min(Math.max(progress, 0), 1) * 100);
  return (
    <Link href={href} className="group block w-full">
      <div
        className={`relative aspect-[2/3] overflow-hidden rounded-ui transition-transform duration-200 ease-out group-hover:scale-[1.03] group-focus-visible:scale-[1.03] group-active:scale-[0.98] ${placeholderFor(seed)}`}
      >
        {image && (
          // eslint-disable-next-line @next/next/no-img-element -- covers come from remote catalogs
          <img src={image} alt="" width={300} height={450} loading="lazy" decoding="async" className="absolute inset-0 h-full w-full object-cover" />
        )}
        {pct !== undefined && (
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct}
            aria-label={title}
            className="absolute inset-x-0 bottom-0 h-1 bg-black/40"
          >
            <div className="h-full bg-accent" style={{ width: `${pct}%` }} />
          </div>
        )}
      </div>
      <p className="mt-2.5 line-clamp-2 text-sm font-bold">{title}</p>
      {caption && <p className="text-xs text-muted">{caption}</p>}
    </Link>
  );
}
