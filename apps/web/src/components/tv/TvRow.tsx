import type { ReactNode } from "react";

import { TvGroup } from "./TvGroup";

type Props = {
  title: string;
  focusKey?: string;
  children: ReactNode;
};

/** A titled horizontal row. It slides as focus moves along it; there is no scrollbar to show. */
export function TvRow({ title, focusKey, children }: Props) {
  return (
    <TvGroup focusKey={focusKey} className="py-2">
      <section aria-label={title} data-tv-section>
        <h2 className="px-[var(--tv-x)] text-[2.75rem] leading-tight">{title}</h2>
        {/* Room above and below so a focused card can grow without being clipped. */}
        <div data-tv-scroller className="no-scrollbar flex gap-8 overflow-x-auto overflow-y-hidden px-[var(--tv-x)] py-8">
          {children}
        </div>
      </section>
    </TvGroup>
  );
}
