"use client";

import { useTranslations } from "next-intl";

import { artImage } from "@/components/ui/artImage";
import { placeholderFor } from "@/components/ui/PosterCard";
import { Link } from "@/i18n/navigation";
import { detailsHref, shareHref, type ShareOut } from "@/lib/messages";

import { icons } from "./icons";

const pill =
  "press inline-flex min-h-11 items-center justify-center gap-2 rounded-full border px-4 text-[13px] font-bold";

/** A shared title as a card: wide art when there is some (an episode still or the show's
 * picture), else the poster beside the text. The poster colour holds the place while art loads
 * and stands in for art that is hidden or missing. */
export function ShareCard({ share }: { share: ShareOut }) {
  const t = useTranslations("messages");
  const part =
    share.episode != null ? t("episode", { n: share.episode }) : share.chapter != null ? t("chapter", { n: share.chapter }) : null;
  const wide = share.kind === "anime" && !!share.image;
  const seed = placeholderFor(share.id);

  if (share.hidden) {
    return (
      <div className="flex w-[min(18.75rem,72vw)] items-start gap-3 rounded-ui border border-line-strong bg-surface p-3">
        <span aria-hidden="true" className="flex aspect-[2/3] w-16 shrink-0 items-center justify-center rounded-ui bg-line text-xs font-bold text-muted">
          +18
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-display text-2xl leading-tight">{t("adultTitle")}</p>
          {part && <p className="mt-0.5 text-[13px] text-muted">{part}</p>}
          <p className="mt-2 text-[13px] text-muted">{t("adultHidden")}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="w-[min(18.75rem,72vw)] overflow-hidden rounded-ui border border-line-strong bg-surface">
      {wide ? (
        <Link href={detailsHref(share)} tabIndex={-1} aria-hidden="true" className={`relative block aspect-video ${seed}`}>
          {/* eslint-disable-next-line @next/next/no-img-element -- remote catalog art */}
          <img {...artImage(share.image!, "300px")} alt="" loading="lazy" decoding="async" className="absolute inset-0 h-full w-full object-cover" />
        </Link>
      ) : null}
      <div className={`flex gap-3 p-3 ${wide ? "" : "items-start"}`}>
        {!wide && (
          <Link href={detailsHref(share)} tabIndex={-1} aria-hidden="true" className={`relative block aspect-[2/3] w-16 shrink-0 overflow-hidden rounded-ui ${seed}`}>
            {share.poster && (
              // eslint-disable-next-line @next/next/no-img-element -- remote catalog art
              <img src={share.poster} alt="" loading="lazy" decoding="async" className="absolute inset-0 h-full w-full object-cover" />
            )}
          </Link>
        )}
        <div className="min-w-0 flex-1">
          <Link href={detailsHref(share)} className="block font-display text-2xl leading-tight hover:underline">
            {share.title}
          </Link>
          {part && <p className="mt-0.5 text-[13px] text-muted">{part}</p>}
          <div className="mt-3 flex flex-wrap gap-2">
            <Link href={shareHref(share)} className={`${pill} border-line-strong text-fg hover:border-accent`}>
              {share.kind === "anime" ? icons.play : icons.book}
              {share.kind === "anime" ? t("play") : t("read")}
            </Link>
            {share.kind === "anime" && (
              <Link href={detailsHref(share)} className={`${pill} border-line text-soft hover:border-line-strong`}>
                {t("details")}
              </Link>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
