"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";

import { PlayerIcon } from "@/components/player/icons";

import { ButtonLink } from "./Button";
import { HeroSplit } from "./HeroSplit";

export type HeroSlide = {
  id: number;
  title: string;
  href: string;
  meta?: string;
  synopsis?: string;
  /** Set when the synopsis is not in the reader's language. */
  synopsisNote?: string;
  /** Portrait poster, shown in place of the wide art when there is none. */
  image?: string | null;
  /** Wide picture of the show: fills the banner's right side. */
  wideArt?: string | null;
};

const INTERVAL_MS = 8000;

/** Flat banner that rotates through a few titles: kicker, big serif title and a pill, beside the art.
 * Rotation pauses on hover and focus, stops with the button beside the dots (the only way on a touch
 * screen) and never starts for people who prefer reduced motion. */
export function HeroCarousel({ slides, cta }: { slides: HeroSlide[]; cta: string }) {
  const t = useTranslations("home");
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [stopped, setStopped] = useState(false);
  const [reduced, setReduced] = useState(true);
  // Slides whose picture is in the page: the ones shown so far plus the one coming next, so the
  // banner downloads one picture first and the rest only as it rotates.
  const [loaded, setLoaded] = useState<ReadonlySet<number>>(() => new Set([0]));

  useEffect(() => {
    if (slides.length < 2) return;
    const next = (index + 1) % slides.length;
    // Not at once: the shown picture and the first rows go first.
    const timer = setTimeout(() => setLoaded((set) => (set.has(index) && set.has(next) ? set : new Set(set).add(index).add(next))), 1500);
    return () => clearTimeout(timer);
  }, [index, slides.length]);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReduced(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    if (slides.length < 2 || paused || stopped || reduced) return;
    const timer = setTimeout(() => setIndex((i) => (i + 1) % slides.length), INTERVAL_MS);
    return () => clearTimeout(timer);
  }, [index, slides.length, paused, stopped, reduced]);

  // Every slide carries its own copy beside its pill; only the visible slide's copy can be reached.
  const dots = slides.length > 1 && (
    <div className="flex items-center gap-1">
      {slides.map((slide, i) => (
        <button
          key={slide.id}
          type="button"
          aria-label={t("goToSlide", { n: i + 1 })}
          aria-current={i === index}
          onClick={() => setIndex(i)}
          className="flex h-6 w-8 items-center justify-center pointer-coarse:h-11 pointer-coarse:w-11"
        >
          {/* Grows with a transform, never a width change. */}
          <span
            className={`h-1 w-6 origin-left rounded-full transition-[transform,background-color] duration-300 ease-out ${i === index ? "scale-x-100 bg-accent" : "scale-x-50 bg-fg/30"}`}
          />
        </button>
      ))}
      <span aria-hidden className="ml-2 whitespace-nowrap text-xs font-medium tabular-nums text-muted lg:text-sm short:hidden">
        {index + 1} / {slides.length}
      </span>
      {!reduced && (
        <button
          type="button"
          aria-label={t(stopped ? "resumeSlides" : "pauseSlides")}
          onClick={() => setStopped((s) => !s)}
          className="press ml-1 flex h-8 w-8 items-center justify-center rounded-full text-muted hover:text-fg pointer-coarse:h-11 pointer-coarse:w-11 [&>svg]:h-4 [&>svg]:w-4"
        >
          <PlayerIcon name={stopped ? "play" : "pause"} />
        </button>
      )}
    </div>
  );

  return (
    <section
      aria-roledescription="carousel"
      aria-label={t("featured")}
      className="relative grid bg-bg pt-16 sm:pt-20 short:pt-12"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      // Moving focus between the banner's own controls should not restart the timer.
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget) && setPaused(false)}
    >
      {slides.map((slide, i) => {
        const active = i === index;
        // Long romaji titles step down a size so they stay within three or four lines on a phone.
        // Beside the art the text column is narrow, so the sizes grow late, and keep growing on wide screens
        // so the column stays filled.
        // On a phone held sideways the title stays small and short, so the pill fits the first screen.
        const size =
          slide.title.length > 28
            ? "text-4xl md:text-5xl xl:text-7xl 2xl:text-8xl min-[150rem]:text-9xl short:line-clamp-2 short:text-3xl"
            : "text-5xl md:text-6xl xl:text-8xl 2xl:text-9xl short:line-clamp-2 short:text-4xl";
        // Centered beside the art, as one block from the kicker down to the pill and the dots.
        const text = (
          <div className="min-w-0 2xl:max-w-3xl min-[150rem]:max-w-4xl">
            <p className="kicker 2xl:text-sm">{t("featured")}</p>
            {active ? (
              <h1 className={`mt-4 short:mt-2 break-words leading-[0.95] tracking-[-0.02em] ${size}`}>{slide.title}</h1>
            ) : (
              <p className={`mt-4 short:mt-2 break-words font-display leading-[0.95] tracking-[-0.02em] ${size}`}>{slide.title}</p>
            )}
            {slide.meta && <p className="mt-5 text-sm font-medium text-muted lg:text-base 2xl:text-lg min-[150rem]:text-xl short:mt-3">{slide.meta}</p>}
            {slide.synopsis && (
              <p className="mt-3 line-clamp-3 max-w-lg leading-relaxed text-soft lg:text-lg 2xl:max-w-2xl 2xl:text-xl min-[150rem]:max-w-3xl min-[150rem]:text-2xl short:hidden">
                {slide.synopsis}
              </p>
            )}
            {slide.synopsis && slide.synopsisNote && <p className="mt-1 text-xs text-muted short:hidden">{slide.synopsisNote}</p>}
            <div className="mt-7 flex flex-wrap items-center gap-x-7 gap-y-4 2xl:mt-9 short:mt-4 short:gap-y-1">
              <ButtonLink href={slide.href} className="px-6 lg:min-h-12 lg:px-8 lg:text-base 2xl:min-h-14 2xl:px-10 2xl:text-lg">
                {cta}
              </ButtonLink>
              {dots}
            </div>
          </div>
        );
        return (
          <div
            key={slide.id}
            role="group"
            aria-roledescription="slide"
            aria-label={t("slide", { n: i + 1, total: slides.length })}
            aria-hidden={!active}
            inert={!active}
            // Every slide sits in the same grid cell, so the banner is as tall as the tallest one.
            className={`col-start-1 row-start-1 transition-opacity duration-300 ease-out ${active ? "opacity-100" : "opacity-0"}`}
          >
            <HeroSplit
              art={loaded.has(i) || active ? slide.wideArt : null}
              poster={loaded.has(i) || active ? slide.image : null}
              eager={i === 0}
              shortSplit
            >
              {text}
            </HeroSplit>
          </div>
        );
      })}
    </section>
  );
}
