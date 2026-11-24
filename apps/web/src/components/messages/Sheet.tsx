"use client";

import { useTranslations } from "next-intl";
import { useEffect, type ReactNode } from "react";

import { BottomSheet } from "@/components/ui/BottomSheet";

import { icons } from "./icons";

type Props = {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Pinned under the scrolling body: the main action. */
  footer?: ReactNode;
  /** What the sheet is about, pinned above the body. On a phone held sideways it becomes the
   * left column, with the footer under it, and the body scrolls in the right one. */
  lead?: ReactNode;
  /** Where the popover sits from sm up; centred on the screen by default. */
  desktop?: string;
};

const CENTRED =
  "sm:fixed sm:inset-x-auto sm:bottom-auto sm:left-1/2 sm:top-1/2 sm:-translate-x-1/2 sm:-translate-y-1/2 sm:w-[26rem] sm:max-h-[min(40rem,85dvh)]";
// Sideways there is no height to stack in, so the sheet goes wide and splits in two.
const SPLIT =
  "short:grid short:h-[calc(100dvh-1.5rem)]! short:max-h-none! short:w-[min(46rem,calc(100vw-2rem))]! short:grid-cols-2 short:grid-rows-[auto_minmax(0,1fr)_auto]";

/** A bottom sheet on phones and a popover on larger screens, with a title, a close button, a
 * scrolling body and an optional footer. Escape and a tap outside close it. */
export function Sheet({ title, onClose, children, footer, lead, desktop = CENTRED }: Props) {
  const t = useTranslations("messages");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <>
      <button type="button" tabIndex={-1} aria-hidden="true" onClick={onClose} className="fixed inset-0 z-[60] cursor-default bg-black/70 sm:bg-black/40" />
      <BottomSheet
        label={title}
        onClose={onClose}
        className={`fixed inset-x-0 bottom-0 z-[61] flex max-h-[85dvh] flex-col rounded-t-ui border-t border-line-strong bg-surface text-fg sm:rounded-ui sm:border ${desktop} ${lead ? SPLIT : ""}`}
      >
        {({ dismiss, handleProps }) => (
          <>
            <div {...handleProps} className={`shrink-0 px-4 pt-2 sm:px-5 sm:pt-4 short:col-span-2 short:pt-2 ${handleProps.className}`}>
              <span aria-hidden="true" className="mx-auto mb-1 block h-1 w-10 rounded-full bg-line-strong sm:hidden" />
              <div className="flex items-center gap-3">
                <h2 className="min-w-0 flex-1 truncate font-sans text-base font-bold">{title}</h2>
                <button
                  type="button"
                  onClick={dismiss}
                  aria-label={t("close")}
                  className="press -mr-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-muted hover:text-fg"
                >
                  {icons.close}
                </button>
              </div>
            </div>
            {lead && <div className="shrink-0 short:col-start-1 short:row-start-2 short:min-h-0 short:overflow-y-auto">{lead}</div>}
            <div
              className={`min-h-0 flex-1 overflow-y-auto overscroll-contain ${lead ? "short:col-start-2 short:row-span-2 short:row-start-2 short:border-l short:border-line" : ""}`}
            >
              {children}
            </div>
            {footer && (
              <div className={`shrink-0 px-4 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-3 sm:px-5 sm:pb-5 ${lead ? "border-t border-line short:col-start-1 short:row-start-3 short:border-t-0 short:pb-4" : ""}`}>
                {footer}
              </div>
            )}
          </>
        )}
      </BottomSheet>
    </>
  );
}
