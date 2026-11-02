import { errorCode } from "@app/api-client";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { GridSkeleton } from "@/components/grid/PosterGrid";
import { KindSwitch } from "@/components/list/KindSwitch";
import { LinkMalCard } from "@/components/list/LinkMalCard";
import { ListView } from "@/components/list/ListView";
import { LIST_STATUSES, type ListKind } from "@/lib/catalog";
import { toApiError } from "@/lib/errors";
import { MANGA_LIST_STATUSES } from "@/lib/manga";
import { expiredSessionPath, serverApi, unwrap } from "@/lib/server-api";

type Props = { kind: ListKind; locale: string; status: string | string[] | undefined };

async function Entries({ kind, locale, status }: Props) {
  const api = await serverApi();
  const { connected } = await unwrap(api.GET("/me/mal"), locale);
  if (!connected) return <LinkMalCard />;

  const value = Array.isArray(status) ? status[0] : status;
  if (kind === "manga") {
    const { data, error, response } = await api.GET("/me/mangalist", { params: { query: {} } });
    if (data !== undefined) return <ListView kind="manga" entries={data.data} initial={MANGA_LIST_STATUSES.find((s) => s === value) ?? "reading"} />;
    return failed(error, response, locale);
  }
  const { data, error, response } = await api.GET("/me/animelist", { params: { query: {} } });
  if (data !== undefined) return <ListView kind="anime" entries={data.data} initial={LIST_STATUSES.find((s) => s === value) ?? "watching"} />;
  return failed(error, response, locale);
}

/** Not unwrap: a 401 here means the MyAnimeList token expired, not the MoonRoom session. */
function failed(error: unknown, response: Response, locale: string) {
  const code = errorCode(error);
  if (code === "mal_session_expired" || code === "mal_not_linked") return <LinkMalCard expired={code === "mal_session_expired"} />;
  if (response.status === 401) redirect(expiredSessionPath(locale));
  throw toApiError(response.status, error);
}

/** My list: the user's MyAnimeList anime or manga list, with the other one a pill away. */
export async function ListPage(props: Props) {
  setRequestLocale(props.locale);
  const t = await getTranslations("list");
  return (
    <section className="px-4 pb-8 pt-24 sm:px-8">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-4xl sm:text-5xl">{t("title")}</h1>
        <KindSwitch kind={props.kind} />
      </div>
      <Suspense fallback={<GridSkeleton />}>
        <Entries {...props} />
      </Suspense>
    </section>
  );
}
