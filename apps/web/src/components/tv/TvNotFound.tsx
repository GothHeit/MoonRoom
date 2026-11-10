import { useTranslations } from "next-intl";

import { TvNotice } from "./TvNotice";
import { TvPillLink } from "./TvPillLink";

const HOME_KEY = "tv-notfound-home";

/** The TV mode's "page not found": the remote lands on a pill that goes to the TV home. */
export function TvNotFound({ bare }: { bare?: boolean }) {
  const t = useTranslations();
  return (
    <TvNotice bare={bare} initial={HOME_KEY} title={t("states.notFoundTitle")} body={t("states.notFoundBody")}>
      <TvPillLink href="/tv" focusKey={HOME_KEY}>
        {t("actions.goHome")}
      </TvPillLink>
    </TvNotice>
  );
}
