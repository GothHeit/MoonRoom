"use client";

import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";

import { Switch } from "@/components/account/Switch";
import { useToast } from "@/components/ui/Toast";
import { usePathname, useRouter } from "@/i18n/navigation";
import { routing } from "@/i18n/routing";
import { api } from "@/lib/api";
import { languageName } from "@/lib/manga";

/** Saves each change right away (a switch has no submit button) and tells the user it worked. */
export function PreferencesForm({
  showNsfw,
  shareActivity,
  mangaLang,
}: {
  showNsfw: boolean;
  shareActivity: boolean;
  mangaLang: string | null;
}) {
  const t = useTranslations("account.settings");
  const tLocale = useTranslations("locale");
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const toast = useToast();
  const [nsfw, setNsfw] = useState(showNsfw);
  const [share, setShare] = useState(shareActivity);
  const [manga, setManga] = useState(mangaLang ?? "auto");
  const [busy, setBusy] = useState(false);

  async function save(body: { locale?: "pt" | "en"; show_nsfw?: boolean; share_activity?: boolean; manga_lang?: string }) {
    setBusy(true);
    const { response } = await api.PATCH("/me", { body }).catch(() => ({ response: null }));
    setBusy(false);
    if (!response?.ok) {
      toast(t("saveFailed"), "error");
      return false;
    }
    toast(t("saved"), "success");
    return true;
  }

  async function onNsfw(next: boolean) {
    setNsfw(next);
    if (await save({ show_nsfw: next })) router.refresh();
    else setNsfw(!next);
  }

  async function onShare(next: boolean) {
    setShare(next);
    if (!(await save({ share_activity: next }))) setShare(!next);
  }

  async function onLocale(next: "pt" | "en") {
    if (await save({ locale: next })) router.replace(pathname, { locale: next });
  }

  async function onManga(next: string) {
    const before = manga;
    setManga(next);
    if (!(await save({ manga_lang: next }))) setManga(before);
  }

  return (
    <div className="flex flex-col gap-6">
      <label className="flex flex-col gap-1">
        <span className="text-sm text-muted">{t("language")}</span>
        <select
          value={locale}
          disabled={busy}
          onChange={(e) => onLocale(e.target.value as "pt" | "en")}
          className="w-full max-w-xs rounded-ui border border-line bg-bg px-3 h-11 text-fg"
        >
          {routing.locales.map((l) => (
            <option key={l} value={l}>
              {tLocale(l)}
            </option>
          ))}
        </select>
        <span className="text-xs text-muted">{t("languageHint")}</span>
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-sm text-muted">{t("mangaLanguage")}</span>
        <select
          value={manga}
          disabled={busy}
          onChange={(e) => onManga(e.target.value)}
          className="w-full max-w-xs rounded-ui border border-line bg-bg px-3 h-11 text-fg"
        >
          <option value="auto">{t("mangaLanguageAuto")}</option>
          <option value="pt-br">{languageName("pt-br")}</option>
          <option value="en">{languageName("en")}</option>
        </select>
        <span className="text-xs text-muted">{t("mangaLanguageHint")}</span>
      </label>

      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="font-medium">{t("contentFilter")}</p>
          <p className="mt-1 text-sm text-muted">{t("contentFilterHint")}</p>
        </div>
        <Switch checked={nsfw} onChange={onNsfw} label={t("contentFilterLabel")} disabled={busy} />
      </div>

      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="font-medium">{t("shareActivity")}</p>
          <p className="mt-1 text-sm text-muted">{t("shareActivityHint")}</p>
        </div>
        <Switch checked={share} onChange={onShare} label={t("shareActivityLabel")} disabled={busy} />
      </div>
    </div>
  );
}
