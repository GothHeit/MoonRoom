"use client";

import { useTranslations } from "next-intl";
import { startTransition } from "react";

import { TvButton } from "@/components/tv/TvButton";
import { TvPage } from "@/components/tv/TvPage";
import { useRouter } from "@/i18n/navigation";

/** A TV screen that failed to load: under the top bar, with a retry the remote can reach. */
export default function TvErrorPage({ error, reset }: { error: Error; reset: () => void }) {
  const t = useTranslations();
  const router = useRouter();
  // Reloading the server screens too: a locked or signed-out TV then gets its PIN pad or sign-in.
  const retry = () => startTransition(() => {
    router.refresh();
    reset();
  });
  // Production strips server error messages, so the API's code only shows in development.
  const key = `errors.${error.message}`;
  return (
    <TvPage initial="tv-error-retry" className="flex min-h-[calc(100vh-7.5rem)] flex-col items-center justify-center gap-8 px-[var(--tv-x)] text-center">
      <h1 className="text-[4.5rem] leading-[0.95] tracking-[-0.02em]">{t("states.errorTitle")}</h1>
      <p role="alert" className="max-w-[60rem] text-[1.75rem] text-muted">
        {t.has(key) ? t(key) : t("errors.unknown")}
      </p>
      <TvButton variant="primary" focusKey="tv-error-retry" onPress={retry}>
        {t("actions.retry")}
      </TvButton>
    </TvPage>
  );
}
