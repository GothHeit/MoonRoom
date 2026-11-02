"use client";

import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";

import { placeholderFor } from "@/components/ui/PosterCard";

type Props = {
  src: string | undefined;
  page: number;
  /** The page being read is fetched before its neighbours. */
  priority?: boolean;
};

/** One page, fitted to the screen. A flat panel holds its place while it loads. */
export function PageView({ src, page, priority = false }: Props) {
  const t = useTranslations("reader");
  const [attempt, setAttempt] = useState(0);
  // The outcome is filed under the picture it is about, so a new page starts out loading.
  const [outcome, setOutcome] = useState<{ of: string; state: "ready" | "failed" } | null>(null);
  const current = `${src}-${attempt}`;
  const state = outcome?.of === current ? outcome.state : "loading";
  const setState = (next: "ready" | "failed") => setOutcome({ of: current, state: next });
  const img = useRef<HTMLImageElement>(null);

  // A page that finished loading before React took over never fires onLoad: ask it.
  useEffect(() => {
    const el = img.current;
    if (el?.complete && el.naturalWidth > 0) setOutcome({ of: current, state: "ready" });
  }, [current]);

  return (
    <div className="relative flex h-full items-center justify-center">
      {src && (
        // eslint-disable-next-line @next/next/no-img-element -- chapter pages come through the proxy
        <img
          key={current}
          ref={img}
          src={src}
          alt={t("pageAlt", { page: page + 1 })}
          draggable={false}
          decoding="async"
          fetchPriority={priority ? "high" : "auto"}
          onLoad={() => setState("ready")}
          onError={() => setState("failed")}
          className={`max-h-full max-w-full object-contain transition-opacity duration-200 ${state === "ready" ? "opacity-100" : "opacity-0"}`}
        />
      )}
      {state !== "ready" && (
        <div className={`absolute inset-y-6 left-1/2 aspect-[2/3] max-w-[calc(100%-2rem)] -translate-x-1/2 rounded-ui ${placeholderFor(page)} ${state === "loading" ? "animate-pulse" : ""}`}>
          {state === "failed" && (
            <div className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center text-sm">
              <p>{t("pageFailed")}</p>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setAttempt((n) => n + 1);
                }}
                className="press min-h-11 rounded-full border border-line-strong px-5 font-bold hover:border-accent"
              >
                {t("retry")}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
