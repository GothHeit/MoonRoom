"use client";

import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";

import { removeEntry, setStatus as saveStatus } from "@/components/list/listApi";
import { useErrorMessage } from "@/components/list/useErrorMessage";
import { LIST_STATUSES, type ListStatus } from "@/lib/catalog";

import { tvButtonClass } from "./TvButton";
import { isBack } from "./keys";
import { TvPlayerMenu, type MenuOption } from "./player/TvPlayerMenu";
import { setFocus } from "./spatial";
import { useTvFocus } from "./useTvFocus";

const LIST_KEY = "tv-title-list";

/**
 * The title's place on the person's MyAnimeList list, as a pill beside Play. OK opens the same
 * side panel the player uses; picking a status (or removing the title) saves at once and closes it.
 */
export function TvListControl({ animeId, initial }: { animeId: number; initial: ListStatus | null }) {
  const t = useTranslations("titlePage.list");
  const message = useErrorMessage();
  const [status, setStatusState] = useState<ListStatus | null>(initial);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const busy = useRef(false);

  const close = useCallback(() => {
    setOpen(false);
    // The panel's items unmount with it; hand focus back to the pill that opened it.
    setTimeout(() => setFocus(LIST_KEY), 0);
  }, []);
  const show = () => {
    setProblem(null);
    setOpen(true);
  };
  const { ref, focused } = useTvFocus<HTMLButtonElement>({ focusKey: LIST_KEY, onEnter: show });

  // Back closes the panel instead of leaving the page (ahead of the TV frame's own Back).
  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (!isBack(event)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      close();
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, close]);

  async function apply(next: ListStatus | null) {
    if (busy.current) return;
    busy.current = true;
    setSaving(true);
    const code = await (next ? saveStatus(animeId, next) : removeEntry(animeId));
    busy.current = false;
    setSaving(false);
    if (code) setProblem(message(code));
    else setStatusState(next);
    close();
  }

  const options: MenuOption[] = [
    ...LIST_STATUSES.map((s) => ({ key: s, label: t(`status.${s}`), selected: s === status, onPick: () => void apply(s) })),
    ...(status ? [{ key: "remove", label: t("remove"), selected: false, onPick: () => void apply(null) }] : []),
  ];

  return (
    <>
      <button
        ref={ref}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={saving}
        onClick={show}
        className={tvButtonClass("secondary", focused)}
      >
        <span className="sr-only">{t("label")}: </span>
        {status ? t(`status.${status}`) : t("add")}
        <span aria-hidden="true" className="text-[1.25rem]">
          ▾
        </span>
      </button>
      {problem && (
        <p role="status" className="max-w-[28rem] text-[1.5rem] leading-snug text-danger">
          {problem}
        </p>
      )}
      {open && (
        <div className="fixed inset-0 z-50">
          <TvPlayerMenu title={t("label")} sections={[{ title: t("label"), options }]} empty="" />
        </div>
      )}
    </>
  );
}
