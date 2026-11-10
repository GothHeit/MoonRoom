"use client";

import { useTranslations } from "next-intl";
import { startTransition } from "react";

import { useRouter } from "@/i18n/navigation";

import { TvButton } from "./TvButton";
import { TvNotice } from "./TvNotice";

const RETRY_KEY = "tv-error-retry";

type Props = {
  error: Error;
  reset: () => void;
  /** No top bar above it (the failure took the shell with it, or the player has none). */
  bare?: boolean;
};

/** A TV screen that failed to load, with a retry the remote lands on. */
export function TvErrorNotice({ error, reset, bare }: Props) {
  const t = useTranslations();
  const router = useRouter();
  // Reloading the server screens too: a locked or signed-out TV then gets its PIN pad or sign-in.
  const retry = () =>
    startTransition(() => {
      router.refresh();
      reset();
    });
  // Production strips server error messages, so the API's code only shows in development.
  const key = `errors.${error.message}`;
  return (
    <TvNotice bare={bare} alert initial={RETRY_KEY} title={t("states.errorTitle")} body={t.has(key) && error.message !== "unknown" ? t(key) : t("states.errorBody")}>
      <TvButton variant="primary" focusKey={RETRY_KEY} onPress={retry}>
        {t("actions.retry")}
      </TvButton>
    </TvNotice>
  );
}
