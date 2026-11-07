"use client";

import { useLocale, useTranslations } from "next-intl";
import { useState, type ReactNode } from "react";

import { usePathname, useRouter } from "@/i18n/navigation";
import { routing } from "@/i18n/routing";
import { api } from "@/lib/api";

import { TvButton } from "./TvButton";
import { TvGroup } from "./TvGroup";
import { TvPinEditor } from "./TvPinEditor";

type Status = "idle" | "saved" | "failed" | "pinSaved" | "pinRemoved";

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

/** Language, the +18 switch, the PIN lock and its setting, and signing out. Everything else is managed on a phone or computer. */
export function TvSettings({ userId, username, showNsfw, pinEnabled }: { userId: string; username: string; showNsfw: boolean; pinEnabled: boolean }) {
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

  async function removeAccount() {
    setBusy(true);
    const res = await fetch("/api/tv/accounts/remove", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: userId }),
    }).catch(() => null);
    if (!res?.ok) {
      setBusy(false);
      setStatus("failed");
      return;
    }
    // Fresh from the server: other accounts on the TV get the picker, else the sign-in screen.
    router.replace("/tv/accounts");
    router.refresh();
  }

  async function lockNow() {
    setBusy(true);
    await api.POST("/auth/pin/lock").catch(() => undefined);
    // The layout now builds the PIN pad instead of this screen.
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
      {pinEnabled && (
        <Setting label={t("pin")} hint={t("pinHint")}>
          <TvButton focusKey="tv-lock-now" disabled={busy} onPress={lockNow}>
            {t("lockNow")}
          </TvButton>
        </Setting>
      )}
      <Setting label={t("pinEdit")} hint={t("pinEditHint")}>
        <TvPinEditor pinEnabled={pinEnabled} busy={busy} onDone={(m) => setStatus(m === "saved" ? "pinSaved" : "pinRemoved")} />
      </Setting>
      <Setting label={t("account")} hint={t("accountHint", { name: username })}>
        <TvButton focusKey="tv-switch-account" disabled={busy} onPress={() => router.push("/tv/accounts?back=1")}>
          {t("switchAccount")}
        </TvButton>
        <TvButton focusKey="tv-sign-out" disabled={busy} onPress={removeAccount}>
          {t("removeAccount")}
        </TvButton>
      </Setting>
      <p role="status" className={`mt-8 min-h-[2.25rem] text-[1.5rem] ${status === "failed" ? "text-danger" : "text-success"}`}>
        {status === "saved" ? t("saved") : status === "failed" ? t("saveFailed") : status === "pinSaved" ? t("pinSaved") : status === "pinRemoved" ? t("pinRemoved") : ""}
      </p>
      <p className="mt-4 max-w-[60rem] text-[1.5rem] text-muted">{t("elsewhere")}</p>
    </div>
  );
}
