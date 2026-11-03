import type { ReactNode } from "react";

import { artImage } from "./artImage";

// The art side is 3/5 of the window from md up, the whole width on phones.
export const HERO_SIZES = "(min-width: 768px) 60vw, 100vw";

type Props = {
  /** A wide picture: fills the art side. */
  art?: string | null;
  /** A portrait poster: stands whole on a flat panel when there is no wide picture. */
  poster?: string | null;
  posterAlt?: string;
  eager?: boolean;
  /** Painted over the picture inside the art side, e.g. wide art that streams in after the poster. */
  overlay?: ReactNode;
  children: ReactNode;
};

/**
 * Hero with the show's art on the right side up to the window's edge and the text on the flat
 * background beside it. On phones the art sits on top, full width, and the text below.
 */
export function HeroSplit({ art, poster, posterAlt = "", eager = true, overlay, children }: Props) {
  const image = art ?? poster;
  const loading = { fetchPriority: eager ? "high" : "auto", loading: eager ? "eager" : "lazy" } as const;
  return (
    <div className="grid md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
      <div className="flex min-w-0 flex-col px-4 pb-10 pt-6 sm:px-8 md:justify-center md:py-12">{children}</div>
      <div
        className={`relative order-first aspect-video md:order-none md:aspect-auto md:min-h-[clamp(24rem,36vw,44rem)] md:rounded-bl-ui ${art ? "" : "overflow-hidden bg-surface"}`}
      >
        {image &&
          (art ? (
            // eslint-disable-next-line @next/next/no-img-element -- remote catalog art
            <img
              {...artImage(art, HERO_SIZES)}
              alt=""
              {...loading}
              decoding="async"
              className="absolute inset-0 h-full w-full object-cover md:rounded-bl-ui"
            />
          ) : (
            <>
              {/* No wide art: the poster, blurred and darkened, fills the side; the sharp poster stands on it. */}
              {/* eslint-disable-next-line @next/next/no-img-element -- remote catalog poster */}
              <img
                src={image}
                alt=""
                aria-hidden="true"
                loading="lazy"
                decoding="async"
                className="absolute inset-0 h-full w-full scale-125 object-cover opacity-60 blur-2xl"
              />
              <div aria-hidden="true" className="absolute inset-0 bg-bg/40" />
              {/* eslint-disable-next-line @next/next/no-img-element -- remote catalog poster */}
              <img
                src={image}
                alt={posterAlt}
                {...loading}
                decoding="async"
                className="absolute inset-y-4 left-1/2 h-[calc(100%-2rem)] w-auto -translate-x-1/2 rounded-ui object-contain shadow-2xl shadow-black/50 md:inset-y-10 md:h-[calc(100%-5rem)]"
              />
            </>
          ))}
        {overlay}
      </div>
    </div>
  );
}
