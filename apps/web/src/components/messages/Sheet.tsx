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
  /** Where the popover sits from sm up; centred on the screen by default. */
  desktop?: string;
};

const CENTRED = "sm:fixed sm:left-1/2 sm:top-1/2 sm:-translate-x-1/2 sm:-translate-y-1/2 sm:w-[26rem] sm:max-h-[min(40rem,85dvh)]";

/** A bottom sheet on phones and a popover on larger screens, with a title, a close button, a
 * scrolling body and an optional footer. Escape and a tap outside close it. */
export function Sheet({ title, onClose, children, footer, desktop = CENTRED }: Props) {
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
        className={`fixed inset-x-0 bottom-0 z-[61] flex max-h-[85dvh] flex-col rounded-t-ui border-t border-line-strong bg-surface text-fg sm:bottom-auto sm:inset-x-auto sm:z-[61] sm:rounded-ui sm:border ${desktop}`}
      >
        {({ dismiss, handleProps }) => (
          <>
            <div {...handleProps} className={`shrink-0 px-4 pt-2 sm:px-5 sm:pt-4 ${handleProps.className}`}>
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
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{children}</div>
            {footer && <div className="shrink-0 px-4 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-3 sm:px-5 sm:pb-5">{footer}</div>}
          </>
        )}
      </BottomSheet>
    </>
  );
}
