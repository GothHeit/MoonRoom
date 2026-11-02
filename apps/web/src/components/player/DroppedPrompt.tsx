"use client";

import { useTranslations } from "next-intl";

type Props = { onAccept: () => void; onDismiss: () => void };

/** Asks whether to move a dropped title back to watching after the user finished an episode. */
export function DroppedPrompt({ onAccept, onDismiss }: Props) {
  const t = useTranslations("player");
  return (
    <div
      role="status"
      className="pop-in absolute bottom-28 left-4 w-[min(22rem,calc(100%-2rem))] origin-bottom-left rounded-ui border border-line bg-surface p-4 shadow-lg sm:left-8"
    >
      <p className="font-medium">{t("droppedAsk")}</p>
      <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" onClick={onAccept} className="press inline-flex min-h-11 items-center justify-center rounded-full bg-accent px-5 py-2 text-sm font-bold text-on-accent">
          {t("droppedMove")}
        </button>
        <button type="button" onClick={onDismiss} className="press inline-flex min-h-11 items-center justify-center rounded-full border border-line-strong px-5 py-2 text-sm font-bold">
          {t("droppedKeep")}
        </button>
      </div>
    </div>
  );
}
