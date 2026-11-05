"use client";

import { useLocale, useTranslations } from "next-intl";
import { useState, type ReactNode } from "react";

import { usePathname, useRouter } from "@/i18n/navigation";
import { routing } from "@/i18n/routing";
import { api } from "@/lib/api";

import { TvButton } from "./TvButton";
import { TvGroup } from "./TvGroup";

type Status = "idle" | "saved" | "failed";

function Setting({ label, hint, top, children }: { label: string; hint?: string; top?: boolean; children: ReactNode }) {
  return (
    <TvGroup top={top} className="flex items-center justify-between gap-12 border-b border-line py-8">
      <div className="min-w-0">
        <h2 className="font-sans text-[2rem] font-bold">{label}</h2>
        {hint && <p className="mt-2 max-w-[48rem] text-[1.5rem] text-muted">{hint}</p>}
      </div>
      <div className="flex shrink-0 gap-4">{children}</div>
    </TvGroup>
  );
}

/** Language, the +18 switch and signing out. Everything else is managed on a phone or computer. */
export function TvSettings({ username, showNsfw }: { username: string; showNsfw: boolean }) {
  const t = useTranslations("tv.settings");
  const tLocale = useTranslations("locale");
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const [nsfw, setNsfw] = useState(showNsfw);
  const [status, setStatus] = useState<Status>("idle");
  const [busy, setBusy] = useState(false);

  async function save(body: { locale?: "pt" | "en"; show_nsfw?: boolean }) {
    setBusy(true);
    const { response } = await api.PATCH("/me", { body }).catch(() => ({ response: null }));
    setBusy(false);
    setStatus(response?.ok ? "saved" : "failed");
    return !!response?.ok;
  }

  async function onLocale(next: "pt" | "en") {
    if (next === locale) return;
    if (await save({ locale: next })) router.replace(pathname, { locale: next });
  }

  async function onNsfw(next: boolean) {
    if (next === nsfw) return;
    setNsfw(next);
    if (await save({ show_nsfw: next })) router.refresh();
    else setNsfw(!next);
  }

  async function signOut() {
    setBusy(true);
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    // Fresh from the server, so nothing of the signed-in screens is reused.
    router.replace("/tv/login");
    router.refresh();
  }

  return (
    <div className="px-[var(--tv-x)]">
      <Setting label={t("language")} top>
        {routing.locales.map((l) => (
          <TvButton key={l} focusKey={`tv-locale-${l}`} selected={l === locale} disabled={busy} onPress={() => onLocale(l)}>
            {tLocale(l)}
          </TvButton>
        ))}
      </Setting>
      <Setting label={t("adult")} hint={t("adultHint")}>
        <TvButton focusKey="tv-nsfw-on" selected={nsfw} disabled={busy} onPress={() => onNsfw(true)}>
          {t("show")}
        </TvButton>
        <TvButton focusKey="tv-nsfw-off" selected={!nsfw} disabled={busy} onPress={() => onNsfw(false)}>
          {t("hide")}
        </TvButton>
      </Setting>
      <Setting label={t("account")} hint={t("signedInAs", { name: username })}>
        <TvButton focusKey="tv-sign-out" disabled={busy} onPress={signOut}>
          {t("signOut")}
        </TvButton>
      </Setting>
      <p role="status" className={`mt-8 min-h-[2.25rem] text-[1.5rem] ${status === "failed" ? "text-danger" : "text-success"}`}>
        {status === "saved" ? t("saved") : status === "failed" ? t("saveFailed") : ""}
      </p>
      <p className="mt-4 max-w-[60rem] text-[1.5rem] text-muted">{t("elsewhere")}</p>
    </div>
  );
}
