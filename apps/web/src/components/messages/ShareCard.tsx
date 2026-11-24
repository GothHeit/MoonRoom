"use client";

import { useTranslations } from "next-intl";

import { artImage } from "@/components/ui/artImage";
import { ButtonLink } from "@/components/ui/Button";
import { placeholderFor } from "@/components/ui/PosterCard";
import { Link } from "@/i18n/navigation";
import { detailsHref, shareHref, type ShareOut } from "@/lib/messages";

import { icons } from "./icons";

type Props = {
  share: ShareOut;
  /** What the sender wrote with it: part of the card, so the two read as one message. */
  note?: string | null;
  mine?: boolean;
};

/** A shared title as a card: wide art when there is some (an episode still or the show's
 * picture), else the poster beside the text. The poster colour holds the place while art loads
 * and stands in for art that is hidden or missing. One main action (play or read); the title
 * and the art lead to the details too. */
export function ShareCard({ share, note, mine = false }: Props) {
  const t = useTranslations("messages");
  const part =
    share.episode != null ? t("episode", { n: share.episode }) : share.chapter != null ? t("chapter", { n: share.chapter }) : null;
  const wide = share.kind === "anime" && !!share.image;
  const seed = placeholderFor(share.id);
  const frame = `w-[min(18.75rem,72vw)] overflow-hidden rounded-ui border bg-surface text-left sm:w-[22.5rem] ${note && mine ? "border-accent-deep" : "border-line-strong"}`;
  const words = note ? (
    <p className={`whitespace-pre-wrap break-words px-3.5 py-2.5 text-[15px] leading-snug ${mine ? "bg-accent-deep" : "border-t border-line"}`}>{note}</p>
  ) : null;

  if (share.hidden) {
    return (
      <div className={frame}>
        <div className="flex items-start gap-3 p-3">
          <span aria-hidden="true" className="flex aspect-[2/3] w-16 shrink-0 items-center justify-center rounded-ui bg-line text-xs font-bold text-muted">
            +18
          </span>
          <div className="min-w-0 flex-1">
            <p className="font-display text-2xl leading-tight">{t("adultTitle")}</p>
            {part && <p className="mt-0.5 text-[13px] text-muted">{part}</p>}
            <p className="mt-2 text-[13px] text-muted">{t("adultHidden")}</p>
          </div>
        </div>
        {words}
      </div>
    );
  }

  return (
    <div className={frame}>
      {wide ? (
        <Link href={detailsHref(share)} tabIndex={-1} aria-hidden="true" className={`relative block aspect-video ${seed}`}>
          {/* eslint-disable-next-line @next/next/no-img-element -- remote catalog art */}
          <img {...artImage(share.image!, "360px")} alt="" loading="lazy" decoding="async" className="absolute inset-0 h-full w-full object-cover" />
        </Link>
      ) : null}
      <div className="p-3">
        <div className="flex items-start gap-3">
          {!wide && (
            <Link href={detailsHref(share)} tabIndex={-1} aria-hidden="true" className={`relative block aspect-[2/3] w-16 shrink-0 overflow-hidden rounded-ui ${seed}`}>
              {share.poster && (
                // eslint-disable-next-line @next/next/no-img-element -- remote catalog art
                <img src={share.poster} alt="" loading="lazy" decoding="async" className="absolute inset-0 h-full w-full object-cover" />
              )}
            </Link>
          )}
          <div className="min-w-0 flex-1">
            <Link href={detailsHref(share)} className="line-clamp-3 font-display text-2xl leading-tight hover:underline">
              {share.title}
            </Link>
            {part && <p className="mt-1 text-[13px] text-muted">{part}</p>}
          </div>
        </div>
        <div className="mt-3 flex gap-2">
          <ButtonLink href={shareHref(share)} className="min-w-0 flex-1 px-4">
            {share.kind === "anime" ? icons.play : icons.book}
            {share.kind === "anime" ? t("play") : t("read")}
          </ButtonLink>
          {share.kind === "anime" && (
            <ButtonLink href={detailsHref(share)} variant="secondary" className="min-w-0 flex-1 px-4">
              {t("details")}
            </ButtonLink>
          )}
        </div>
      </div>
      {words}
    </div>
  );
}
