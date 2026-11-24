"use client";

import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";

import { usePresence } from "@/lib/use-presence";

import { icons } from "./icons";

/** The ⋯ menu on your own comments. */
export function OwnMenu({ onEdit, onDelete }: { onEdit: () => void; onDelete: () => void }) {
  const t = useTranslations("comments");
  const root = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const presence = usePresence(open);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const item = "block w-full px-3 py-2 text-left text-sm hover:bg-bg active:bg-bg pointer-coarse:py-3";
  const pick = (action: () => void) => () => {
    setOpen(false);
    action();
  };

  return (
    <div ref={root} className="relative -my-2.5 -mr-3 shrink-0">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("menu")}
        onClick={() => setOpen((v) => !v)}
        className="press flex h-11 w-11 items-center justify-center rounded-full text-muted hover:bg-surface hover:text-fg"
      >
        {icons.dots}
      </button>
      {presence.mounted && (
        <ul
          role="menu"
          data-closing={presence.closing || undefined}
          inert={presence.closing}
          className="pop-in absolute right-1 top-11 z-20 w-40 origin-top-right overflow-hidden rounded-ui border border-line bg-surface"
        >
          <li role="none">
            <button role="menuitem" type="button" className={item} onClick={pick(onEdit)}>
              {t("edit")}
            </button>
          </li>
          <li role="none" className="border-t border-line">
            <button role="menuitem" type="button" className={`${item} text-danger`} onClick={pick(onDelete)}>
              {t("delete")}
            </button>
          </li>
        </ul>
      )}
    </div>
  );
}
