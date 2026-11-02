"use client";

import { useTranslations } from "next-intl";

type Props = {
  onAccept: () => void;
  onDismiss: () => void;
  /** Where the strings live: the player's say "watching", the reader's say "reading". */
  namespace?: "player" | "reader";
  /** Floats over the player by default; inline sits in the reader's end card. */
  inline?: boolean;
};

/** Asks whether to move a dropped title back to watching (or reading) after the user finished it. */
export function DroppedPrompt({ onAccept, onDismiss, namespace = "player", inline = false }: Props) {
  const t = useTranslations(namespace);
  return (
    <div
      role="status"
      className={
        inline
          ? "w-full rounded-ui border border-line bg-surface p-4 text-left"
          : "pop-in absolute bottom-28 left-4 w-[min(22rem,calc(100%-2rem))] origin-bottom-left rounded-ui border border-line bg-surface p-4 shadow-lg sm:left-8"
      }
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
