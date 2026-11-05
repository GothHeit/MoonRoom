"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

import { artImage } from "@/components/ui/artImage";
import { useRouter } from "@/i18n/navigation";

import { tvButtonClass } from "./TvButton";
import { useTvFocus } from "./useTvFocus";

export type TvSlide = {
  id: number;
  title: string;
  href: string;
  meta?: string;
  synopsis?: string;
  image?: string | null;
  /** False when `image` is a portrait poster, which then stands whole on the flat panel. */
  wide: boolean;
};

const ART_SIZES = "60vw";

/** The hero's pill. Left and right flip the featured title instead of moving focus. */
function HeroPlay({ href, label, onFlip }: { href: string; label: string; onFlip?: (step: number) => void }) {
  const router = useRouter();
  const { ref, focused } = useTvFocus<HTMLButtonElement>({
    focusKey: "tv-hero-play",
    onEnter: () => router.push(href),
    onArrow: (direction) => {
      if (!onFlip || (direction !== "left" && direction !== "right")) return true;
      onFlip(direction === "right" ? 1 : -1);
      return false;
    },
  });
  return (
    <button ref={ref} type="button" onClick={() => router.push(href)} className={tvButtonClass("primary", focused)}>
      <span aria-hidden="true">▶</span>
      {label}
    </button>
  );
}

/**
 * The featured titles: kicker, big serif title, synopsis and one pill beside the art. Left and
 * right on the pill flip through the titles; the dots say where you are.
 */
export function TvHero({ slides }: { slides: TvSlide[] }) {
  const t = useTranslations("tv.home");
  const [index, setIndex] = useState(0);
  const slide = slides[index];
  const flip = (step: number) => setIndex((i) => (i + step + slides.length) % slides.length);
  const long = slide.title.length > 28;

  return (
    <div data-tv-section="top" className="grid min-h-[37rem] grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
      <div className="flex min-w-0 flex-col justify-center py-10 pl-[var(--tv-x)] pr-14" aria-live="polite">
        <p className="text-[1.25rem] font-bold uppercase tracking-[0.14em] text-accent">{t("featured")}</p>
        <h1 className={`mt-4 line-clamp-2 leading-[0.95] tracking-[-0.02em] ${long ? "text-[4.25rem]" : "text-[5.5rem]"}`}>{slide.title}</h1>
        {slide.meta && <p className="mt-5 text-[1.5rem] text-muted">{slide.meta}</p>}
        {slide.synopsis && <p className="mt-5 line-clamp-3 text-[1.75rem] leading-snug text-soft">{slide.synopsis}</p>}
        <div className="mt-9 flex items-center gap-8">
          <HeroPlay href={slide.href} label={t("play")} onFlip={slides.length > 1 ? flip : undefined} />
          {slides.length > 1 && (
            <div className="flex items-center gap-3" aria-label={t("slide", { n: index + 1, total: slides.length })} role="img">
              {slides.map((s, i) => (
                <span key={s.id} aria-hidden="true" className={`h-2.5 rounded-full ${i === index ? "w-8 bg-accent" : "w-2.5 bg-line-strong"}`} />
              ))}
            </div>
          )}
        </div>
        {slides.length > 1 && <p className="mt-5 text-[1.375rem] text-muted">{t("flipHint")}</p>}
      </div>
      <div className="relative overflow-hidden rounded-bl-ui bg-surface">
        {slide.image &&
          (slide.wide ? (
            // eslint-disable-next-line @next/next/no-img-element -- remote catalog art
            <img key={slide.id} {...artImage(slide.image, ART_SIZES)} alt="" fetchPriority="high" decoding="async" className="art-fade-in absolute inset-0 h-full w-full object-cover" />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element -- remote catalog poster
            <img key={slide.id} src={slide.image} alt="" fetchPriority="high" decoding="async" className="art-fade-in absolute inset-y-10 left-1/2 h-[calc(100%-5rem)] w-auto -translate-x-1/2 rounded-ui object-contain" />
          ))}
      </div>
    </div>
  );
}
