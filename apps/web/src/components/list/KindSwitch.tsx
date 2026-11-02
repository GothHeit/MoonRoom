import { getTranslations } from "next-intl/server";

import { Link } from "@/i18n/navigation";
import { listHref, type ListKind } from "@/lib/catalog";

const KINDS: ListKind[] = ["anime", "manga"];

/** Anime | Manga pills in the list heading: each kind has its own page, so the address keeps it. */
export async function KindSwitch({ kind }: { kind: ListKind }) {
  const t = await getTranslations("list");
  return (
    <nav aria-label={t("kinds")} className="inline-flex rounded-full border border-line-strong p-1">
      {KINDS.map((k) => {
        const active = k === kind;
        return (
          <Link
            key={k}
            href={listHref(k)}
            aria-current={active ? "page" : undefined}
            className={`press inline-flex min-h-9 items-center rounded-full px-4 text-sm font-bold transition-colors ${active ? "bg-accent text-on-accent" : "text-muted hover:text-fg"}`}
          >
            {t(`kind.${k}`)}
          </Link>
        );
      })}
    </nav>
  );
}
