"use client";

import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/Button";

export default function ErrorPage({ error, reset }: { error: Error; reset: () => void }) {
  const t = useTranslations();
  // Production strips server error messages, so the API's code only shows in development.
  const key = `errors.${error.message}`;

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4 px-4 text-center">
      <h1 className="text-4xl sm:text-5xl">{t("states.errorTitle")}</h1>
      <p role="alert" className="text-muted">
        {t.has(key) && error.message !== "unknown" ? t(key) : t("states.errorBody")}
      </p>
      <Button onClick={reset}>{t("actions.retry")}</Button>
    </div>
  );
}
