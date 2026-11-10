"use client";

import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";

import { tvButtonClass } from "./TvButton";
import { isBack } from "./keys";
import { setFocus } from "./spatial";
import { useTvFocus } from "./useTvFocus";

const SYNOPSIS_KEY = "tv-title-synopsis";

/** The pill-shaped "Read more" under a cut synopsis. Small on purpose: Play stays the main action. */
function More({ label, expanded, onOpen }: { label: string; expanded: boolean; onOpen: () => void }) {
  const { ref, focused } = useTvFocus<HTMLButtonElement>({ focusKey: SYNOPSIS_KEY, onEnter: onOpen });
  return (
    <button
      ref={ref}
      type="button"
      data-tv-aside
      aria-haspopup="dialog"
      aria-expanded={expanded}
      onClick={onOpen}
      className={`-ml-5 mt-2 inline-flex min-h-[3rem] items-center rounded-full px-5 text-[1.5rem] font-bold outline-none transition-transform duration-[160ms] ease-out ${
        focused ? "scale-[1.06] bg-accent text-on-accent" : "text-accent"
      }`}
    >
      {label}
    </button>
  );
}

/**
 * The whole synopsis in a side panel, like the list and player panels. It takes the remote while
 * open: up and down scroll the text, OK or Back close it.
 */
function Panel({ heading, title, text, onClose }: { heading: string; title: string; text: string; onClose: () => void }) {
  const t = useTranslations("actions");
  const scroller = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    button.current?.focus({ preventScroll: true });
    function onKey(event: KeyboardEvent) {
      const back = isBack(event);
      const arrow = event.key.startsWith("Arrow");
      if (!back && !arrow && event.key !== "Enter") return;
      // Ahead of the page's own navigation and of the TV frame's Back.
      event.preventDefault();
      event.stopImmediatePropagation();
      const box = scroller.current;
      if (back || event.key === "Enter") onClose();
      else if (box && event.key === "ArrowDown") box.scrollTop += box.clientHeight * 0.6;
      else if (box && event.key === "ArrowUp") box.scrollTop -= box.clientHeight * 0.6;
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`${heading}: ${title}`}
        className="absolute inset-y-0 right-0 flex w-[60rem] flex-col border-l border-line bg-surface"
      >
        <div className="px-16 pt-14">
          <p className="text-[1.25rem] font-bold uppercase tracking-[0.14em] text-muted">{heading}</p>
          <h2 className="mt-3 line-clamp-2 break-words text-[3rem] leading-[1.05]">{title}</h2>
        </div>
        <div ref={scroller} className="no-scrollbar mt-8 min-h-0 flex-1 overflow-y-auto px-16 pb-10">
          <p className="whitespace-pre-line text-[1.75rem] leading-normal text-soft">{text}</p>
        </div>
        <div className="border-t border-line px-16 py-8">
          <button ref={button} type="button" onClick={onClose} className={tvButtonClass("primary", true)}>
            {t("close")}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The title page's synopsis: four lines, and when that cuts it a "Read more" the remote can reach
 * (up from Play) that opens the whole text.
 */
export function TvSynopsis({ title, text }: { title: string; text: string }) {
  const t = useTranslations("titlePage");
  const clamped = useRef<HTMLParagraphElement>(null);
  const [cut, setCut] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const measure = () => {
      const p = clamped.current;
      if (p) setCut(p.scrollHeight > p.clientHeight + 1);
    };
    measure();
    // The heading font arrives late and the TV scales the page to its screen: measure again.
    window.addEventListener("resize", measure);
    void document.fonts?.ready.then(measure);
    return () => window.removeEventListener("resize", measure);
  }, [text]);

  const close = useCallback(() => {
    setOpen(false);
    // The panel's button unmounts with it; hand focus back to the pill that opened it.
    setTimeout(() => setFocus(SYNOPSIS_KEY), 0);
  }, []);

  return (
    <div className="mt-5">
      <p ref={clamped} className="line-clamp-4 text-[1.75rem] leading-snug text-soft">
        {text}
      </p>
      {cut && <More label={t("readMore")} expanded={open} onOpen={() => setOpen(true)} />}
      {open && <Panel heading={t("synopsis")} title={title} text={text} onClose={close} />}
    </div>
  );
}
