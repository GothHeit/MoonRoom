"use client";

import { useTranslations } from "next-intl";

import { Link } from "@/i18n/navigation";
import type { StreamChoice } from "@/lib/watch-target";

import { streamLabel, type StreamNames } from "./streams";

export const ERRORS = [
  "not_available",
  "source_not_found",
  "upstream_failed",
  "playback_failed",
  "network",
  "too_many_rooms",
  "anime_not_found",
  "room_full",
];

/** The translated text for an error code, or the generic one for a code with no text. */
export function errorKey(code: string): string {
  return `errors.${ERRORS.includes(code) ? code : "unknown"}`;
}

type Props = {
  error: string;
  backHref: string;
  onRetry: () => void;
  /** Other sources and sub/dub versions to offer; empty when this viewer can't switch. */
  others: StreamChoice[];
  names: StreamNames;
  onSwitch: (to: StreamChoice) => void;
};

export function ErrorPanel({ error, backHref, onRetry, others, names, onSwitch }: Props) {
  const t = useTranslations("player");
  return (
    <div className="absolute inset-0 flex items-center justify-center p-6">
      <div role="alert" className="max-w-md text-center">
        <p className="text-lg font-medium">{t(errorKey(error))}</p>
        <div className="mt-6 flex justify-center gap-3">
          {error !== "source_not_found" && error !== "not_available" && (
            <button type="button" onClick={onRetry} className="press inline-flex min-h-11 items-center justify-center rounded-full bg-accent px-5 py-2 text-sm font-bold text-on-accent">
              {t("retry")}
            </button>
          )}
          <Link href={backHref} className="press inline-flex min-h-11 items-center justify-center rounded-full border border-line-strong px-5 py-2 text-sm font-bold">
            {t("back")}
          </Link>
        </div>
        {others.length > 0 && (
          <div className="mt-6">
            <p className="text-sm text-muted">{t("tryAnotherSource")}</p>
            <div className="mt-3 flex flex-wrap justify-center gap-2">
              {others.map((s) => (
                <button
                  key={`${s.source}-${s.lang}`}
                  type="button"
                  onClick={() => onSwitch(s)}
                  className="press inline-flex min-h-11 items-center justify-center rounded-full border border-line-strong px-5 py-2 text-sm font-bold"
                >
                  {streamLabel(names, s)}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
