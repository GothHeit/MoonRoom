"use client";

import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";

import { Switch } from "@/components/account/Switch";
import { languageName } from "@/components/player/languages";
import { useToast } from "@/components/ui/Toast";
import { api } from "@/lib/api";

const DUBS = ["pt", "en", "es"];
const SUBTITLES = ["pt-BR", "en", "es"];
const QUALITIES = [1080, 720, 480] as const;
type Quality = (typeof QUALITIES)[number];

type Props = {
  /** "original", or the language code of the dub to look for. */
  audio: string;
  /** A language code, "off", or null for automatic. */
  subtitle: string | null;
  softSubs: boolean;
  showSkips: boolean;
  /** The tallest quality to prefer; null is the best there is. */
  maxResolution: number | null;
};

const selectClass = "w-full max-w-md rounded-ui border border-line bg-bg px-3 py-2 text-fg";

/** What the automatic source choice looks for. Each change is saved right away. */
export function PlaybackForm(props: Props) {
  const t = useTranslations("account.settings.playback");
  const tSettings = useTranslations("account.settings");
  const locale = useLocale();
  const toast = useToast();
  const [audio, setAudio] = useState(props.audio);
  const [subtitle, setSubtitle] = useState(props.subtitle ?? "auto");
  const [soft, setSoft] = useState(props.softSubs);
  const [skips, setSkips] = useState(props.showSkips);
  const [quality, setQuality] = useState(props.maxResolution ? String(props.maxResolution) : "best");
  const [busy, setBusy] = useState(false);

  async function finish(ok: boolean) {
    setBusy(false);
    toast(ok ? tSettings("saved") : tSettings("saveFailed"), ok ? "success" : "error");
    return ok;
  }

  async function savePreferences(body: { audio_lang?: string; prefer_soft_subs?: boolean; show_skip_buttons?: boolean; max_resolution?: Quality | null }) {
    setBusy(true);
    const { response } = await api.PUT("/watch/preferences", { body }).catch(() => ({ response: null }));
    return finish(!!response?.ok);
  }

  async function onAudio(next: string) {
    const before = audio;
    setAudio(next);
    if (!(await savePreferences({ audio_lang: next }))) setAudio(before);
  }

  async function onSoft(next: boolean) {
    setSoft(next);
    if (!(await savePreferences({ prefer_soft_subs: next }))) setSoft(!next);
  }

  async function onSkips(next: boolean) {
    setSkips(next);
    if (!(await savePreferences({ show_skip_buttons: next }))) setSkips(!next);
  }

  async function onQuality(next: string) {
    const before = quality;
    setQuality(next);
    if (!(await savePreferences({ max_resolution: next === "best" ? null : (Number(next) as Quality) }))) setQuality(before);
  }

  async function onSubtitle(next: string) {
    const before = subtitle;
    setSubtitle(next);
    setBusy(true);
    const { response } = await api.PATCH("/me", { body: { subtitle_lang: next } }).catch(() => ({ response: null }));
    if (!(await finish(!!response?.ok))) setSubtitle(before);
  }

  // A language picked in the player can be one the lists don't offer; keep it selectable.
  const dubs = DUBS.includes(audio) || audio === "original" ? DUBS : [...DUBS, audio];
  const dubName = (code: string) => languageName(code, locale) ?? code;
  const subtitles =
    ["auto", "off", ...SUBTITLES].includes(subtitle) ? SUBTITLES : [...SUBTITLES, subtitle];

  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-muted">{t("intro")}</p>

      <label className="flex flex-col gap-1">
        <span className="text-sm text-muted">{t("audio")}</span>
        <select value={audio} disabled={busy} onChange={(e) => onAudio(e.target.value)} className={selectClass}>
          <option value="original">{t("audioOriginal")}</option>
          {dubs.map((code) => (
            <option key={code} value={code}>
              {t("audioDub", { language: dubName(code) })}
            </option>
          ))}
        </select>
        <span className="text-xs text-muted">{t("audioHint")}</span>
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-sm text-muted">{t("subtitles")}</span>
        <select value={subtitle} disabled={busy} onChange={(e) => onSubtitle(e.target.value)} className={selectClass}>
          <option value="auto">{t("subtitlesAuto")}</option>
          {subtitles.map((code) => (
            <option key={code} value={code}>
              {languageName(code, locale) ?? code}
            </option>
          ))}
          <option value="off">{t("subtitlesOff")}</option>
        </select>
      </label>

      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="font-medium">{t("soft")}</p>
          <p className="mt-1 text-sm text-muted">{t("softHint")}</p>
        </div>
        <Switch checked={soft} onChange={onSoft} label={t("soft")} disabled={busy} />
      </div>

      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="font-medium">{t("skips")}</p>
          <p className="mt-1 text-sm text-muted">{t("skipsHint")}</p>
        </div>
        <Switch checked={skips} onChange={onSkips} label={t("skips")} disabled={busy} />
      </div>

      <label className="flex flex-col gap-1">
        <span className="text-sm text-muted">{t("quality")}</span>
        <select value={quality} disabled={busy} onChange={(e) => onQuality(e.target.value)} className={selectClass}>
          <option value="best">{t("qualityBest")}</option>
          {QUALITIES.map((q) => (
            <option key={q} value={q}>
              {t("qualityUpTo", { height: q })}
            </option>
          ))}
        </select>
        <span className="text-xs text-muted">{t("qualityHint")}</span>
      </label>
    </div>
  );
}
