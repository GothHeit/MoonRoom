"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";

import { useRouter } from "@/i18n/navigation";
import { api } from "@/lib/api";
import { CoverCard } from "@/components/manga/CoverCard";
import { useToast } from "@/components/ui/Toast";

type Props = {
  mangaId: number;
  href: string;
  title: string;
  image?: string | null;
  caption?: string;
  progress?: number;
};

/** A Continue reading card with a button that takes the title off the row. Reading history is kept. */
export function ContinueReadingCard({ mangaId, ...card }: Props) {
  const t = useTranslations("manga");
  const tErr = useTranslations("errors");
  const router = useRouter();
  const toast = useToast();
  const [removed, setRemoved] = useState(false);

  async function remove() {
    setRemoved(true);
    try {
      const { response } = await api.DELETE("/manga/{manga_id}/continue", { params: { path: { manga_id: mangaId } } });
      if (!response.ok) throw new Error("remove failed");
      router.refresh();
    } catch {
      setRemoved(false);
      toast(tErr("unknown"), "error");
    }
  }

  if (removed) return null;
  return (
    <div className="group/card relative">
      <CoverCard {...card} seed={mangaId} />
      <button
        type="button"
        onClick={remove}
        aria-label={t("removeFromContinue", { title: card.title })}
        className="press absolute right-1 top-1 flex h-11 w-11 items-center justify-center rounded-full text-white opacity-0 focus-visible:opacity-100 group-hover/card:opacity-100 max-md:opacity-100 pointer-coarse:opacity-100"
      >
        <span aria-hidden="true" className="flex h-8 w-8 items-center justify-center rounded-full bg-black/70 text-sm">✕</span>
      </button>
    </div>
  );
}
