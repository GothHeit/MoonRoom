"use client";

import { FocusContext, useFocusable } from "@noriginmedia/norigin-spatial-navigation";
import { useTranslations } from "next-intl";
import { useEffect, type ReactNode } from "react";

import { setAutoNext } from "@/components/player/autoNext";
import { errorKey } from "@/components/player/ErrorPanel";
import { streamLabel, type StreamNames } from "@/components/player/streams";
import type { StreamChoice } from "@/lib/watch-target";

import { artImage } from "@/components/ui/artImage";
import { placeholderFor } from "@/components/ui/PosterCard";

import { TvButton } from "../TvButton";
import { setFocus } from "../spatial";

/** A centred, flat card over the black stage that keeps the remote inside it. */
function Card({ focusKey, start, label, children }: { focusKey: string; start: string; label?: string; children: ReactNode }) {
  const { ref, focusKey: key } = useFocusable<object, HTMLDivElement>({ focusKey, isFocusBoundary: true, trackChildren: true });
  useEffect(() => {
    setFocus(start);
  }, [start]);
  return (
    <FocusContext.Provider value={key}>
      <div className="absolute inset-0 flex items-center justify-center px-[var(--tv-x)]">
        <div ref={ref} role="alert" aria-label={label} className="w-full max-w-[64rem] rounded-ui border border-line bg-bg px-16 py-14 text-center">
          {children}
        </div>
      </div>
    </FocusContext.Provider>
  );
}

type ErrorProps = {
  error: string;
  onRetry: () => void;
  onExit: () => void;
  /** Other sources and sub/dub versions to try. */
  others: StreamChoice[];
  names: StreamNames;
  onSwitch: (to: StreamChoice) => void;
};

const MAX_OTHERS = 4;

/** Why the episode can't play, with a retry, other sources and a way back. */
export function TvPlayerError({ error, onRetry, onExit, others, names, onSwitch }: ErrorProps) {
  const t = useTranslations("player");
  const tv = useTranslations("tv.player");
  const canRetry = error !== "source_not_found" && error !== "not_available";
  return (
    <Card focusKey="tvp-error" start={canRetry ? "tvp-error-retry" : others.length ? "tvp-error-other-0" : "tvp-error-back"}>
      <h2 className="text-[3.5rem] leading-tight">{tv("errorTitle")}</h2>
      <p className="mt-5 text-[1.75rem] leading-snug text-soft">{t(errorKey(error))}</p>
      <div className="mt-10 flex flex-wrap justify-center gap-6">
        {canRetry && (
          <TvButton variant="primary" focusKey="tvp-error-retry" onPress={onRetry}>
            {t("retry")}
          </TvButton>
        )}
        <TvButton focusKey="tvp-error-back" onPress={onExit}>
          {t("back")}
        </TvButton>
      </div>
      {others.length > 0 && (
        <>
          <p className="mt-12 text-[1.5rem] text-muted">{t("tryAnotherSource")}</p>
          <div className="mt-5 flex flex-wrap justify-center gap-5">
            {others.slice(0, MAX_OTHERS).map((s, i) => (
              <TvButton key={`${s.source}-${s.lang}`} focusKey={`tvp-error-other-${i}`} onPress={() => onSwitch(s)}>
                {streamLabel(names, s)}
              </TvButton>
            ))}
          </div>
        </>
      )}
    </Card>
  );
}

type EndProps = {
  /** The show's title. */
  title: string;
  next: number | undefined;
  /** The next episode's own title, when the catalog has one. */
  nextTitle: string | null;
  /** The next episode's still: a proxied source thumbnail or catalog art. */
  still: string | null;
  stillFromSource: boolean;
  /** Wide art for the title, behind the whole screen. */
  backdrop: string | null;
  poster: string | null;
  countdown: number | null;
  /** Seconds the countdown starts from, for its bar. */
  total: number;
  autoNext: boolean;
  onPlayNext: () => void;
  onCancelCountdown: () => void;
  onExit: () => void;
};

/** The end screen's frame: the title's art, darkened, under everything; keeps the remote inside. */
function EndScreen({ start, backdrop, poster, children }: { start: string; backdrop: string | null; poster: string | null; children: ReactNode }) {
  const { ref, focusKey } = useFocusable<object, HTMLDivElement>({ focusKey: "tvp-end", isFocusBoundary: true, trackChildren: true });
  useEffect(() => {
    setFocus(start);
  }, [start]);
  return (
    <FocusContext.Provider value={focusKey}>
      <div ref={ref} role="alert" className="absolute inset-0 overflow-hidden bg-bg">
        {(backdrop || poster) && (
          // eslint-disable-next-line @next/next/no-img-element -- remote catalog art
          <img {...(backdrop ? artImage(backdrop, "100vw") : { src: poster ?? "" })} alt="" decoding="async" className="art-fade-in absolute inset-0 h-full w-full object-cover" />
        )}
        {/* Player-only exception: a dark veil so text reads over any art. */}
        <div aria-hidden="true" className="absolute inset-0 bg-bg/90" />
        <div className="relative flex h-full items-center gap-[6rem] px-[var(--tv-x)]">{children}</div>
      </div>
    </FocusContext.Provider>
  );
}

/** When an episode ends: the next one with its still and countdown, or the end of what's there. */
export function TvEndCard(props: EndProps) {
  const { title, next, nextTitle, still, stillFromSource, backdrop, poster, countdown, total, autoNext, onPlayNext, onCancelCountdown, onExit } = props;
  const t = useTranslations("player");
  const tv = useTranslations("tv.player");
  if (next === undefined) {
    return (
      <EndScreen start="tvp-end-back" backdrop={backdrop} poster={poster}>
        <div className="min-w-0 flex-1">
          <p className="line-clamp-1 text-[1.75rem] font-bold text-soft">{title}</p>
          <h2 className="mt-4 max-w-[56rem] text-[4.5rem] leading-[1.05]">{t("finished")}</h2>
          <div className="mt-12 flex">
            <TvButton variant="primary" focusKey="tvp-end-back" onPress={onExit}>
              {t("back")}
            </TvButton>
          </div>
        </div>
        {poster && (
          // eslint-disable-next-line @next/next/no-img-element -- remote catalog poster
          <img src={poster} alt="" decoding="async" className="aspect-[2/3] w-[24rem] shrink-0 rounded-ui border border-line object-cover" />
        )}
      </EndScreen>
    );
  }
  const elapsed = countdown === null ? 0 : (total - countdown) / total;
  // No still for the episode: the title's wide art, then its poster, then the episode number.
  const picture = still ? (stillFromSource ? { src: still } : artImage(still, "44rem")) : backdrop ? artImage(backdrop, "44rem") : poster ? { src: poster } : null;
  return (
    <EndScreen start="tvp-end-next" backdrop={backdrop} poster={poster}>
      <div className="min-w-0 flex-1">
        <p className="text-[1.375rem] font-bold uppercase tracking-[0.14em] text-accent">{tv("upNext")}</p>
        <p className="mt-5 line-clamp-1 text-[1.75rem] font-bold text-soft">{title}</p>
        <h2 className="mt-2 text-[5rem] leading-[1.05]">{t("episode", { episode: next })}</h2>
        {nextTitle && <p className="mt-3 line-clamp-2 text-[2.25rem] font-bold leading-tight">{nextTitle}</p>}
        <p className="mt-6 text-[1.75rem] text-soft" aria-live="polite">
          {countdown !== null ? tv("startsIn", { seconds: countdown }) : tv("paused")}
        </p>
        <div className="mt-12 flex flex-wrap gap-x-7 gap-y-6">
          <TvButton variant="primary" focusKey="tvp-end-next" onPress={onPlayNext}>
            {t("playNow")}
          </TvButton>
          {/* One button that turns from Cancel into Back, so focus stays on it. */}
          <TvButton focusKey="tvp-end-second" onPress={countdown !== null ? onCancelCountdown : onExit}>
            {countdown !== null ? t("cancel") : t("back")}
          </TvButton>
          <TvButton
            focusKey="tvp-end-auto"
            onPress={() => {
              setAutoNext(!autoNext);
              if (autoNext) onCancelCountdown();
            }}
          >
            {tv(autoNext ? "autoNextOn" : "autoNextOff")}
          </TvButton>
        </div>
      </div>
      <div className={`relative aspect-video w-[44rem] shrink-0 overflow-hidden rounded-ui border border-line ${placeholderFor(next)}`}>
        {picture ? (
          // eslint-disable-next-line @next/next/no-img-element -- stills come from the source or ani.zip
          <img {...picture} alt="" decoding="async" className="absolute inset-0 h-full w-full object-cover object-top" />
        ) : (
          <span aria-hidden="true" className="absolute bottom-5 left-6 font-display text-[6rem] leading-none text-accent">
            {String(next).padStart(2, "0")}
          </span>
        )}
        {countdown !== null && (
          <div aria-hidden="true" className="absolute inset-x-0 bottom-0 h-2 bg-line">
            <div
              className="h-full origin-left bg-accent transition-transform duration-1000 ease-linear motion-reduce:transition-none"
              style={{ transform: `scaleX(${elapsed})` }}
            />
          </div>
        )}
      </div>
    </EndScreen>
  );
}
