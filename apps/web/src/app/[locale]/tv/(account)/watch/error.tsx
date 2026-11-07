"use client";

import { useTranslations } from "next-intl";

import { TvButton } from "@/components/tv/TvButton";
import { TvPage } from "@/components/tv/TvPage";

/** The TV player's page failed to load (the title, the account): full screen, with a retry. */
export default function TvWatchErrorPage({ error, reset }: { error: Error; reset: () => void }) {
  const t = useTranslations();
  const key = `errors.${error.message}`;
  return (
    <TvPage bare initial="tv-error-retry" className="flex min-h-dvh flex-col items-center justify-center gap-8 px-[var(--tv-x)] text-center">
      <h1 className="text-[4.5rem] leading-[0.95] tracking-[-0.02em]">{t("states.errorTitle")}</h1>
      <p role="alert" className="max-w-[60rem] text-[1.75rem] text-muted">
        {t.has(key) ? t(key) : t("errors.unknown")}
      </p>
      <TvButton variant="primary" focusKey="tv-error-retry" onPress={reset}>
        {t("actions.retry")}
      </TvButton>
    </TvPage>
  );
}
