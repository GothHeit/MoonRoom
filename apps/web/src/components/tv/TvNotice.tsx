"use client";

import type { ReactNode } from "react";

import { TvPage } from "./TvPage";

type Props = {
  title: string;
  body: string;
  /** The item to focus on arrival: the screen's main action. */
  initial: string;
  /** No top bar above it: the notice takes the whole screen. */
  bare?: boolean;
  /** Announce the body at once (an error). */
  alert?: boolean;
  /** The actions, as TV pills. */
  children: ReactNode;
};

/** A TV screen that only has something to say (not found, failed to load) and a pill to move on. */
export function TvNotice({ title, body, initial, bare = false, alert = false, children }: Props) {
  return (
    <TvPage
      bare={bare}
      initial={initial}
      className={`flex flex-col items-center justify-center gap-8 px-[var(--tv-x)] text-center ${bare ? "min-h-dvh" : "min-h-[calc(100vh-7.5rem)]"}`}
    >
      <h1 className="text-[4.5rem] leading-[0.95] tracking-[-0.02em]">{title}</h1>
      <p role={alert ? "alert" : undefined} className="max-w-[60rem] text-[1.75rem] text-muted">
        {body}
      </p>
      <div className="mt-2 flex flex-wrap items-center justify-center gap-6">{children}</div>
    </TvPage>
  );
}
