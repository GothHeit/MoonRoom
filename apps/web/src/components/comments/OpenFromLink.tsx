"use client";

import { useSearchParams } from "next/navigation";
import { useState } from "react";

import { usePathname, useRouter } from "@/i18n/navigation";
import type { CommentScope, TitleKind } from "@/lib/comments";

import { CommentsPanel } from "./CommentsPanel";

const MAX_EPISODE = 10_000;

/** The episode or chapter a link like a reply notice's (?comment=…&ep=5, or &ch=112) points at. */
function scopeOf(kind: TitleKind, id: number, params: URLSearchParams): CommentScope | null {
  if (kind === "anime") {
    const episode = Number(params.get("ep"));
    return Number.isInteger(episode) && episode >= 1 && episode <= MAX_EPISODE ? { kind: "episode", animeId: id, episode } : null;
  }
  const chapter = params.get("ch");
  return chapter && chapter.length <= 16 ? { kind: "chapter", mangaId: id, chapter } : null;
}

/** Opens an episode's or chapter's comments over the title page when a link asks for it. */
export function OpenFromLink({ kind, id, title }: { kind: TitleKind; id: number; title: string }) {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const [scope, setScope] = useState(() => scopeOf(kind, id, new URLSearchParams(params.toString())));
  if (!scope) return null;
  return (
    <CommentsPanel
      scope={scope}
      title={title}
      focusId={params.get("comment")}
      onClose={() => {
        setScope(null);
        // Drop the link's question, so a reload or Back doesn't open it again.
        const rest = new URLSearchParams(params.toString());
        for (const key of ["comment", "ep", "ch"]) rest.delete(key);
        const query = rest.toString();
        router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
      }}
    />
  );
}
