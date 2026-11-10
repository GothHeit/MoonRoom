"use client";

import { FocusContext, useFocusable } from "@noriginmedia/norigin-spatial-navigation";
import { useEffect, useRef } from "react";

import { useTvFocus } from "../useTvFocus";
import { setFocus } from "../spatial";

export type MenuOption = { key: string; label: string; selected: boolean; onPick: () => void };
export type MenuSection = { title: string; options: MenuOption[] };

const MENU_KEY = "tvp-menu";
const optionKey = (key: string) => `tvp-menu-${key}`;

function Option({ option }: { option: MenuOption }) {
  const { ref, focused } = useTvFocus<HTMLButtonElement>({
    focusKey: optionKey(option.key),
    onEnter: option.onPick,
    remember: false,
    // The panel scrolls itself; the page behind it never moves.
    onFocus: () => ref.current?.scrollIntoView({ block: "nearest" }),
  });
  return (
    <li>
      <button
        ref={ref}
        type="button"
        role="menuitemradio"
        aria-checked={option.selected}
        onClick={option.onPick}
        className={`flex min-h-[4.5rem] w-full items-center gap-5 rounded-full px-8 text-left text-[1.75rem] font-bold outline-none transition-transform duration-[160ms] ease-out ${
          focused ? "scale-[1.03] bg-accent text-on-accent" : option.selected ? "text-fg" : "text-soft"
        }`}
      >
        <span aria-hidden="true" className={`w-7 shrink-0 text-center ${focused ? "" : "text-accent"}`}>
          {option.selected ? "✓" : ""}
        </span>
        <span className="min-w-0 flex-1 break-words leading-tight">{option.label}</span>
      </button>
    </li>
  );
}

type Props = {
  title: string;
  sections: MenuSection[];
  /** Shown while the sections have nothing to offer yet. */
  empty: string;
};

/**
 * The player's side panel (subtitles, audio, source): lists of choices with the current one
 * ticked. Focus stays inside it until Back closes it, and starts on the current choice.
 */
export function TvPlayerMenu({ title, sections, empty }: Props) {
  const { ref, focusKey } = useFocusable<object, HTMLDivElement>({ focusKey: MENU_KEY, isFocusBoundary: true, trackChildren: true });
  const options = sections.flatMap((s) => s.options);
  // A heading per section only when there is more than one to tell apart.
  const headed = sections.filter((s) => s.options.length > 0).length > 1;
  const start = options.find((o) => o.selected) ?? options[0];
  const startKey = start ? optionKey(start.key) : undefined;

  // Once, as soon as there is something to focus (the source list may still be on its way).
  // Later picks keep focus where the person is.
  const placed = useRef(false);
  useEffect(() => {
    if (!startKey || placed.current) return;
    placed.current = true;
    setFocus(startKey);
  }, [startKey]);

  return (
    <FocusContext.Provider value={focusKey}>
      <div
        ref={ref}
        role="dialog"
        aria-label={title}
        className="no-scrollbar absolute inset-y-0 right-0 w-[40rem] overflow-y-auto border-l border-line bg-surface px-10 py-14"
      >
        <h2 className="px-8 text-[3rem] leading-none">{title}</h2>
        {options.length === 0 && <p className="mt-8 px-8 text-[1.75rem] text-muted">{empty}</p>}
        {sections.map((section) =>
          section.options.length === 0 ? null : (
            <section key={section.title} className={headed ? "mt-10" : "mt-8"}>
              {headed && <h3 className="px-8 text-[1.25rem] font-bold uppercase tracking-[0.14em] text-muted">{section.title}</h3>}
              <ul role="menu" aria-label={section.title} className="mt-3 space-y-1">
                {section.options.map((option) => (
                  <Option key={option.key} option={option} />
                ))}
              </ul>
            </section>
          ),
        )}
      </div>
    </FocusContext.Provider>
  );
}
