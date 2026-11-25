import type { components } from "@app/api-client";

import type { Lang } from "@/lib/watch-target";

/** One choice of the Language menu, as the API checked it for this episode. */
export type LanguageChoice = components["schemas"]["LanguageOut"];
export type Spoken = LanguageChoice["language"];

const ISO3: Record<string, string> = { por: "pt", eng: "en", jpn: "ja" };

/** "pt-BR", "por" and "pt" are all "pt"; empty is "". */
export function baseLang(tag: string | null | undefined): string {
  const head = (tag ?? "").trim().toLowerCase().split(/[-_]/)[0];
  return ISO3[head] ?? head;
}

/** What the player has loaded right now: the stream's own tracks and which are on. */
export type NowPlaying = {
  audioTracks: { id: number; lang?: string }[];
  /** Id of the audio track on, or -1. */
  audioTrack: number;
  subtitles: { lang: string }[];
  /** Index of the subtitle track shown, or -1 for none. */
  subtitle: number;
  /** The source and sub/dub that answered. */
  source: string;
  lang: Lang;
};

/** A switch that only turns tracks on and off in the loaded stream: no reload. */
export type TrackMove = { audio?: number; subtitle: number };

const SPOKEN: readonly string[] = ["pt", "en"];

function sameStream(choice: LanguageChoice, now: NowPlaying) {
  return choice.source === now.source && choice.lang === now.lang;
}

/** Which menu choice is playing, read from the tracks that are on; null when none fits. */
export function playingChoice(choices: LanguageChoice[], now: NowPlaying): { language: Spoken; kind: Lang } | null {
  const audio = now.audioTracks.find((a) => a.id === now.audioTrack);
  const heard = baseLang(audio?.lang);
  if (audio && SPOKEN.includes(heard)) return { language: heard as Spoken, kind: "dub" };
  if (!audio && now.lang === "dub") {
    const dub = choices.find((c) => c.kind === "dub" && sameStream(c, now));
    return dub ? { language: dub.language, kind: "dub" } : null;
  }
  const read = now.subtitle >= 0 ? baseLang(now.subtitles[now.subtitle]?.lang) : "";
  if (SPOKEN.includes(read)) return { language: read as Spoken, kind: "sub" };
  // Subtitles burned into the picture: the stream itself is the choice.
  const burned = choices.find((c) => c.kind === "sub" && sameStream(c, now));
  return burned ? { language: burned.language, kind: "sub" } : null;
}

/**
 * How to reach a choice without reloading, when the loaded stream already carries it (a dub as an
 * audio track, subtitles as a switchable track); null when it takes another stream.
 */
export function instantMove(choice: Pick<LanguageChoice, "language" | "kind" | "source" | "lang">, now: NowPlaying): TrackMove | null {
  const same = sameStream(choice as LanguageChoice, now);
  if (choice.kind === "dub") {
    const track = now.audioTracks.find((a) => baseLang(a.lang) === choice.language);
    if (track) return { audio: track.id, subtitle: -1 };
    return same && now.audioTracks.length === 0 ? { subtitle: -1 } : null;
  }
  // Subtitled means the original audio.
  const original = now.audioTracks.find((a) => baseLang(a.lang) === "ja");
  const hasOriginal = now.audioTracks.length === 0 ? now.lang === "sub" : original !== undefined;
  if (!hasOriginal) return null;
  const subtitle = now.subtitles.findIndex((s) => baseLang(s.lang) === choice.language);
  if (subtitle >= 0) return { audio: original?.id, subtitle };
  return same ? { audio: original?.id, subtitle: -1 } : null;
}

/** Query values that make the player start a choice on its own stream: the audio and the
 * subtitles to show. */
export function startWith(choice: Pick<LanguageChoice, "language" | "kind">): { audio: string; subs: string } {
  if (choice.kind === "dub") return { audio: choice.language, subs: "off" };
  return { audio: "original", subs: choice.language === "pt" ? "pt-BR" : "en" };
}
