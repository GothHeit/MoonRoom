"use client";

import { FocusContext, useFocusable } from "@noriginmedia/norigin-spatial-navigation";
import { useTranslations } from "next-intl";
import { useEffect, type ReactNode } from "react";

import { setAutoNext } from "@/components/player/autoNext";
import { errorKey } from "@/components/player/ErrorPanel";
import { streamLabel, type StreamNames } from "@/components/player/streams";
import type { StreamChoice } from "@/lib/watch-target";

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
  next: number | undefined;
  countdown: number | null;
  autoNext: boolean;
  onPlayNext: () => void;
  onCancelCountdown: () => void;
  onExit: () => void;
};

/** When an episode ends: the next one with its countdown, or the end of what's there. */
export function TvEndCard({ next, countdown, autoNext, onPlayNext, onCancelCountdown, onExit }: EndProps) {
  const t = useTranslations("player");
  const tv = useTranslations("tv.player");
  if (next === undefined) {
    return (
      <Card focusKey="tvp-end" start="tvp-end-back">
        <h2 className="text-[3.5rem] leading-tight">{t("finished")}</h2>
        <div className="mt-10 flex justify-center">
          <TvButton variant="primary" focusKey="tvp-end-back" onPress={onExit}>
            {t("back")}
          </TvButton>
        </div>
      </Card>
    );
  }
  return (
    <Card focusKey="tvp-end" start="tvp-end-next">
      <p className="text-[1.25rem] font-bold uppercase tracking-[0.14em] text-accent">{tv("upNext")}</p>
      <h2 className="mt-4 text-[3.5rem] leading-tight">{t("episode", { episode: next })}</h2>
      <p className="mt-4 text-[1.75rem] text-soft" aria-live="polite">
        {countdown !== null ? tv("startsIn", { seconds: countdown }) : tv("paused")}
      </p>
      <div className="mt-10 flex flex-wrap justify-center gap-6">
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
    </Card>
  );
}
