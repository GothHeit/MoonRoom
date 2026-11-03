"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";

type Props = {
  title: string;
  children: ReactNode;
  /** Tailwind width class for each item. Tall posters are narrower than wide cards. */
  itemClassName?: string;
  /** Extra classes on the section, e.g. negative margins. */
  className?: string;
};

/** Horizontal scroller with arrow buttons and Left/Right keys. */
export function Row({ title, children, itemClassName = "w-36 sm:w-44", className = "" }: Props) {
  const t = useTranslations("row");
  const scroller = useRef<HTMLUListElement>(null);
  const [edge, setEdge] = useState({ start: true, end: false });

  const measure = useCallback(() => {
    const el = scroller.current;
    if (el) setEdge({ start: el.scrollLeft <= 1, end: el.scrollLeft + el.clientWidth >= el.scrollWidth - 1 });
  }, []);

  useEffect(() => {
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [measure]);

  function scroll(direction: -1 | 1) {
    const el = scroller.current;
    if (el) el.scrollBy({ left: direction * el.clientWidth * 0.85, behavior: "smooth" });
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowRight") scroll(1);
    else if (e.key === "ArrowLeft") scroll(-1);
    else return;
    e.preventDefault();
  }

  // Arrows fade out at the ends of the row. A hidden arrow leaves the tab order; the list keeps its arrow keys.
  const arrow = (hidden: boolean) =>
    `press absolute top-1/2 z-10 hidden h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full border border-line-strong bg-bg/90 text-fg hover:border-accent md:flex ${hidden ? "pointer-events-none opacity-0" : ""}`;
  const hiddenProps = (hidden: boolean) => (hidden ? { "aria-hidden": true, tabIndex: -1 } : {});

  return (
    <section aria-label={title} className={`group/row relative ${className}`}>
      <h2 className="mb-4 px-4 text-2xl sm:px-8 sm:text-[1.75rem]">{title}</h2>
      <div className="relative">
        <button type="button" aria-label={t("previous")} onClick={() => scroll(-1)} className={`${arrow(edge.start)} left-2`} {...hiddenProps(edge.start)}>
          ‹
        </button>
        <ul
          ref={scroller}
          tabIndex={0}
          aria-label={title}
          onKeyDown={onKeyDown}
          onScroll={measure}
          className="no-scrollbar flex snap-x scroll-px-4 gap-3 overflow-x-auto scroll-smooth px-4 pb-2 pt-1 sm:scroll-px-8 sm:gap-5 sm:px-8"
        >
          {Array.isArray(children)
            ? children.map((child, i) => (
                <li key={i} className={`shrink-0 snap-start ${itemClassName}`}>
                  {child}
                </li>
              ))
            : <li className={`shrink-0 snap-start ${itemClassName}`}>{children}</li>}
        </ul>
        <button type="button" aria-label={t("next")} onClick={() => scroll(1)} className={`${arrow(edge.end)} right-2`} {...hiddenProps(edge.end)}>
          ›
        </button>
      </div>
    </section>
  );
}
