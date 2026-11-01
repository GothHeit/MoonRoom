"use client";

import { useTranslations } from "next-intl";

import { Link } from "@/i18n/navigation";

import { setAutoNext } from "./autoNext";

type Props = {
  /** The next episode, or undefined at the end of the season. */
  next: number | undefined;
  /** Seconds left before the next episode starts, or null when no countdown runs. */
  countdown: number | null;
  autoNext: boolean;
  backHref: string;
  onPlayNext: () => void;
  onCancelCountdown: () => void;
};

/** Shown when an episode ends: the next episode with its countdown, or a way back. */
export function EndCard({ next, countdown, autoNext, backHref, onPlayNext, onCancelCountdown }: Props) {
  const t = useTranslations("player");
  return (
    <div className="pop-in absolute bottom-28 right-4 w-[min(22rem,calc(100%-2rem))] origin-bottom-right rounded-ui border border-line bg-surface p-4 shadow-lg sm:right-8">
      {next !== undefined ? (
        <>
          <p className="font-medium" aria-live="polite">
            {countdown !== null ? t("nextIn", { episode: next, seconds: countdown }) : t("nextReady", { episode: next })}
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <button type="button" onClick={onPlayNext} className="press inline-flex min-h-11 items-center justify-center rounded-full bg-accent px-5 py-2 text-sm font-bold text-on-accent">
              {t("playNow")}
            </button>
            {countdown !== null && (
              <button
                type="button"
                onClick={onCancelCountdown}
                className="press inline-flex min-h-11 items-center justify-center rounded-full border border-line-strong px-5 py-2 text-sm font-bold"
              >
                {t("cancel")}
              </button>
            )}
          </div>
          <label className="mt-4 flex items-center gap-2 text-sm text-muted">
            <input
              type="checkbox"
              checked={autoNext}
              onChange={(e) => {
                setAutoNext(e.target.checked);
                if (!e.target.checked) onCancelCountdown();
              }}
              className="accent-accent"
            />
            {t("autoNext")}
          </label>
        </>
      ) : (
        <>
          <p className="font-medium">{t("finished")}</p>
          <Link href={backHref} className="mt-4 press inline-flex min-h-11 items-center justify-center rounded-full bg-accent px-5 py-2 text-sm font-bold text-on-accent">
            {t("back")}
          </Link>
        </>
      )}
    </div>
  );
}
