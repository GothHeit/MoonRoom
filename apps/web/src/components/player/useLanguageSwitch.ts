"use client";

import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";

import { api } from "@/lib/api";
import { AUTO_SOURCE } from "@/lib/pick-stream";
import { watchHref, type Lang } from "@/lib/watch-target";

import { instantMove, playingChoice, startWith, type LanguageChoice, type NowPlaying } from "./languageMenu";
import { useLanguages } from "./useLanguages";

/** One choice of the Language menu, ready to show (web settings sheet and TV side panel). */
export type LanguageRow = {
  key: string;
  /** The language it belongs to, the heading it is listed under. */
  section: string;
  label: string;
  /** Quality and source, "Checking…", or why it can't be picked. */
  detail: string;
  checked: boolean;
  disabled: boolean;
  checking: boolean;
  onPick: () => void;
};

/** The small status line over the picture: a switch in progress, or one that failed. */
export type LanguageNotice = { text: string; busy: boolean };

type Options = {
  animeId: number;
  episode: number;
  /** Off in rooms, which keep their source menu, and until the stream is up. */
  enabled: boolean;
  /** A stream is loaded (instant switches need its tracks). */
  loaded: boolean;
  now: NowPlaying;
  /** Heights the loaded stream offers. */
  heights: number[];
  chooseAudio: (id: number) => void;
  /** Shows a subtitle track and saves it as the viewer's choice. */
  chooseSubtitle: (index: number) => void;
  /** Shows a subtitle track for this stream only. */
  showSubtitle: (index: number) => void;
  position: () => number;
  /** Opens the episode at another address (the web or the TV watch page). */
  reload: (href: string) => void;
  /** Called as a choice is picked: the menu closes. */
  onPicked: () => void;
};

const NOTICE_MS = 5000;
const EMPTY: LanguageChoice[] = (["pt", "en"] as const).flatMap((language) =>
  (["sub", "dub"] as const).map((kind): LanguageChoice => ({ language, kind, state: "none" })),
);

/**
 * The Language menu: Portuguese and English, subtitled or dubbed, each checked on this episode by
 * the API. Picking one switches tracks in place when the loaded stream carries the language, and
 * otherwise resolves the stream that plays it while this one keeps going, then reloads onto it at
 * the same moment. The pick is saved as the viewer's audio and subtitle preference.
 */
export function useLanguageSwitch(o: Options) {
  const t = useTranslations("player");
  const languages = useLanguages(o.animeId, o.episode, o.enabled);
  const [notice, setNotice] = useState<LanguageNotice | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const spoken = (language: string, kind: Lang) =>
    t("language.name", { language: t(`language.${language}`), kind: t(`language.${kind}`) });
  // A source's short name ("Zoko"), from its labels ("Zoko · Subtitled").
  const sourceName = (name: string) => (t.has(`streams.${name}.sub`) ? t(`streams.${name}.sub`).split(" · ")[0] : name);

  const playing = languages.choices ? playingChoice(languages.choices, o.now) : null;
  const label = playing ? spoken(playing.language, playing.kind) : t("language.other");
  // Worth a button only when the check found something to switch to.
  const offered = o.enabled && languages.choices !== null && languages.choices.some((c) => c.state !== "none");
  const busy = notice?.busy === true;

  function rows(): LanguageRow[] {
    const checking = languages.choices === null && !languages.failed;
    return (languages.choices ?? EMPTY).map((choice) => {
      const instant = o.loaded ? instantMove(choice, o.now) : null;
      const checked = playing?.language === choice.language && playing.kind === choice.kind;
      const parts: string[] = [];
      if (instant) {
        // The loaded stream's best quality; a plain video file says it only through the check.
        const height = o.heights.length > 0 ? Math.max(...o.heights) : choice.source === o.now.source ? choice.resolution : null;
        if (height) parts.push(t("language.height", { height }));
        parts.push(sourceName(o.now.source));
        if (!checked) parts.push(t("language.instant"));
      } else if (choice.state !== "none" && choice.source) {
        if (choice.resolution) parts.push(t("language.height", { height: choice.resolution }));
        parts.push(sourceName(choice.source));
        if (choice.state === "unverified") parts.push(t("language.unverified"));
      }
      const playable = checked || instant !== null || (choice.state !== "none" && !!choice.source);
      return {
        key: `${choice.language}-${choice.kind}`,
        section: t(`language.${choice.language}`),
        label: t(`language.${choice.kind}`),
        detail: parts.length > 0 ? parts.join(" · ") : checking ? t("language.checking") : t("language.none"),
        checked,
        disabled: !playable || busy,
        checking: checking && parts.length === 0,
        onPick: () => void pick(choice),
      };
    });
  }

  function say(next: LanguageNotice | null) {
    clearTimeout(timer.current);
    setNotice(next);
    if (next && !next.busy) timer.current = setTimeout(() => setNotice(null), NOTICE_MS);
  }

  async function pick(choice: LanguageChoice) {
    if (busy) return;
    o.onPicked();
    const instant = instantMove(choice, o.now);
    const start = startWith(choice);
    if (instant) {
      // Same video: only the tracks change. Picking audio saves it as the preference already.
      if (instant.audio !== undefined && instant.audio !== o.now.audioTrack) o.chooseAudio(instant.audio);
      if (choice.kind === "sub") o.chooseSubtitle(instant.subtitle);
      else o.showSubtitle(instant.subtitle);
      return;
    }
    if (!choice.source || !choice.lang) return;
    const name = spoken(choice.language, choice.kind);
    say({ text: t("language.switching", { language: name }), busy: true });
    // Remembered like a track pick, and the title goes back to the automatic choice, which
    // looks for this language from now on.
    const saved = Promise.all([
      api.PUT("/watch/preferences", { body: { audio_lang: start.audio } }).catch(() => undefined),
      choice.kind === "sub" ? api.PATCH("/me", { body: { subtitle_lang: start.subs } }).catch(() => undefined) : undefined,
      api
        .PUT("/watch/choice/{anime_id}", { params: { path: { anime_id: o.animeId } }, body: { source: AUTO_SOURCE, lang: "sub" } })
        .catch(() => undefined),
    ]);
    // Resolve the new stream while this one keeps playing, so the reload finds it ready.
    const { data } = await api
      .POST("/watch/{source}/{anime_id}/episodes/{episode}/play", {
        params: { path: { source: choice.source, anime_id: o.animeId, episode: o.episode }, query: { lang: choice.lang, audio: start.audio } },
      })
      .catch(() => ({ data: undefined }));
    await saved;
    // Another source answering means the picked one failed, and it may not have the language.
    if (!data || data.source !== choice.source) {
      say({ text: t("language.failed", { language: name }), busy: false });
      return;
    }
    o.reload(watchHref(data.source, o.animeId, o.episode, data.lang, o.position(), start));
  }

  // The menu is listed while the check runs and when it found something; otherwise the source
  // menu is all there is.
  const listed = o.enabled && (offered || (languages.choices === null && !languages.failed));
  return { offered, listed, label, rows, notice };
}
