"use client";

import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";

import { AssSubtitles } from "@/components/player/AssSubtitles";
import { useAutoNext } from "@/components/player/autoNext";
import { languageName, trackNames } from "@/components/player/languages";
import { sameStream, streamLabel, type StreamNames } from "@/components/player/streams";
import { activeSkip } from "@/components/player/skips";
import { SubtitleOverlay } from "@/components/player/SubtitleOverlay";
import { SIZES, type SubtitleStyle } from "@/components/player/subtitleStyle";
import { useHls } from "@/components/player/useHls";
import { usePlayback } from "@/components/player/usePlayback";
import { useProgressSaver } from "@/components/player/useProgressSaver";
import { useSkips } from "@/components/player/useSkips";
import { useSubtitles } from "@/components/player/useSubtitles";
import { togglePlayback } from "@/components/player/useVideoControls";
import { useRouter } from "@/i18n/navigation";
import { api } from "@/lib/api";
import { AUTO_SOURCE } from "@/lib/pick-stream";
import { warmPlayback } from "@/lib/warm-playback";
import { watchHref, type Lang, type StreamChoice } from "@/lib/watch-target";

import { isBack, mediaKey, registerMediaKeys } from "../keys";
import { tvHref } from "../paths";
import { setFocus } from "../spatial";
import { useTvSeek } from "./seek";
import { TvEndCard, TvPlayerError } from "./TvPlayerCards";
import { PLAY_KEY, SEEK_KEY, TvControl, TvSeekBar } from "./TvPlayerControls";
import { TvPlayerMenu, type MenuSection } from "./TvPlayerMenu";
import { usePlainSubtitles } from "./usePlainSubtitles";

type Props = {
  source: string;
  animeId: number;
  episode: number;
  title: string;
  /** Sorted episode numbers the source has, used for the next episode. May be empty. */
  episodes: number[];
  lang: Lang;
  /** Seconds to start from: the saved position, or where a source switch left off. */
  startAt: number;
  /** Saved subtitle choice: a language code, "off", or null for automatic. */
  subtitleLang: string | null;
  subtitleStyle: SubtitleStyle;
  showSkips: boolean;
};

type Panel = "subtitles" | "audio" | "source";

// Longer than the site's 3 s: the person is across the room and the remote is slower.
const HIDE_CONTROLS_MS = 5000;
const NEXT_COUNTDOWN = 10;
const WARM_NEXT_SECONDS = 180;
const ARROWS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]);
// Room the control bar takes at the bottom, so subtitles sit above it while it shows.
const CONTROLS_HEIGHT = "16rem";

const PANEL_BUTTON: Record<Panel, string> = { subtitles: "tvp-subtitles", audio: "tvp-audio", source: "tvp-source" };

/**
 * The TV mode's player: the same play pipeline as the site (sources with fallback, signed links,
 * subtitles, progress, skips, next episode), driven by the remote. While it plays nothing is on
 * screen; any key brings up the controls. Left and right seek, OK plays or pauses, Back
 * closes a panel or leaves, and the media keys work whenever the TV hands them over.
 */
export function TvPlayer(props: Props) {
  const { source, animeId, episode, title, episodes, lang, startAt, subtitleLang, showSkips } = props;
  const t = useTranslations("player");
  const tv = useTranslations("tv.player");
  const locale = useLocale();
  const router = useRouter();
  const video = useRef<HTMLVideoElement>(null);
  const started = useRef(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const playback = usePlayback(source, animeId, episode, lang);
  const { attempt, url, kind, tracks, fonts, answered, answeredLang, ownSkips, defaultAudio, maxHeight, error, setError } = playback;
  const [panel, setPanel] = useState<Panel | null>(null);
  const [streams, setStreams] = useState<StreamChoice[]>([]);
  const [askStreams, setAskStreams] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [waiting, setWaiting] = useState(true);
  const [current, setCurrent] = useState(startAt);
  const [duration, setDuration] = useState(0);
  const [active, setActive] = useState(true);
  const [ended, setEnded] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const autoNext = useAutoNext();
  const [plain, setPlain] = usePlainSubtitles();

  const playbackRetry = playback.retry;
  const retry = useCallback(() => {
    started.current = false;
    playbackRetry();
  }, [playbackRetry]);
  const failPlayback = useCallback(() => setError("playback_failed"), [setError]);
  const subtitles = useSubtitles(tracks, subtitleLang, props.subtitleStyle);
  const { selected, styled, style } = subtitles;
  const drawStyled = styled && !plain ? styled : null;
  const hls = useHls({ video, url, kind, defaultAudio, maxHeight, onRetry: retry, onFail: failPlayback });
  const seek = useTvSeek(video);

  const names: StreamNames = { has: (key) => t.has(key), t: (key, values) => t(key, values) };
  const playingFrom: StreamChoice = { source: answered, lang: answeredLang };
  const automatic = source === AUTO_SOURCE;
  const picked: StreamChoice = automatic ? { source, lang } : playingFrom;
  const playingName = streamLabel(names, playingFrom);
  const audioNames = hls.audioTracks.map((a) => ({ ...a, label: languageName(a.lang, locale) ?? a.label }));
  const titleHref = tvHref(`/anime/${animeId}`);

  const next = episodes.find((e) => e > episode);
  const nearEnd = next !== undefined && duration > 0 && current > Math.max(duration - WARM_NEXT_SECONDS, duration / 2);
  useEffect(() => {
    if (nearEnd && next !== undefined) warmPlayback(source, animeId, next, lang);
  }, [nearEnd, source, animeId, next, lang]);
  const { save, onTime } = useProgressSaver(video, animeId, episode);

  useEffect(() => registerMediaKeys(), []);

  const wantStreams = askStreams || panel === "source" || error !== null;
  const streamsAsked = useRef(false);
  useEffect(() => {
    if (!wantStreams || streamsAsked.current) return;
    let cancelled = false;
    api
      .GET("/watch/options/{anime_id}/{episode}", { params: { path: { anime_id: animeId, episode } } })
      .then(({ data }) => {
        if (cancelled || !data) return;
        streamsAsked.current = true;
        setStreams(data);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [animeId, episode, wantStreams]);

  const length = url && Number.isFinite(duration) && duration > 0 ? Math.round(duration) : 0;
  const skips = useSkips(ownSkips, animeId, episode, showSkips ? length : 0);
  const skip = showSkips ? activeSkip(skips, current) : undefined;
  const skipNow = useCallback(() => {
    const v = video.current;
    const target = showSkips ? activeSkip(skips, v?.currentTime ?? 0) : undefined;
    if (v && target) v.currentTime = target.end;
  }, [skips, showSkips]);

  // Back to the title page. The player replaces itself when it moves to another episode or
  // source, so the history entry before it is the screen it was opened from.
  const exit = useCallback(() => {
    if (window.history.length > 1) router.back();
    else router.replace(titleHref);
  }, [router, titleHref]);

  const goNext = useCallback(() => {
    if (next !== undefined) router.replace(tvHref(watchHref(source, animeId, next, lang)));
  }, [next, router, source, animeId, lang]);

  useEffect(() => {
    if (countdown === null) return;
    if (countdown <= 0) {
      goNext();
      return;
    }
    const id = setTimeout(() => setCountdown((c) => (c === null ? null : c - 1)), 1000);
    return () => clearTimeout(id);
  }, [countdown, goNext]);

  const poke = useCallback(() => {
    setActive(true);
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setActive(false), HIDE_CONTROLS_MS);
  }, []);
  useEffect(() => () => clearTimeout(hideTimer.current), []);

  const togglePlay = useCallback(() => {
    const v = video.current;
    if (!v || !url) return;
    // OK on a pending seek lands there first, then carries on.
    if (seek.pending()) {
      seek.commit();
      if (v.paused) void v.play().catch(() => undefined);
      return;
    }
    togglePlayback(v);
  }, [url, seek]);

  const closePanel = useCallback(() => setPanel(null), []);

  function switchStream(to: StreamChoice) {
    setPanel(null);
    if (sameStream(to, playingFrom) && !error) return;
    if (sameStream(to, { source, lang })) {
      retry();
      return;
    }
    void api.PUT("/watch/choice/{anime_id}", { params: { path: { anime_id: animeId } }, body: to }).catch(() => undefined);
    router.replace(tvHref(watchHref(to.source, animeId, episode, to.lang, video.current?.currentTime ?? current)));
  }

  function chooseAudio(id: number) {
    hls.chooseAudio(id);
    const found = hls.audioTracks.find((a) => a.id === id)?.lang;
    if (found) void api.PUT("/watch/preferences", { body: { audio_lang: found } }).catch(() => undefined);
  }

  const shown = active || !playing || ended || panel !== null || seek.target !== null || error !== null;
  // What the remote is driving: a card or panel keeps it, otherwise the control card does.
  const mode = error ? "error" : ended ? "ended" : panel ? "panel" : "controls";

  // Latest values for the key listener, which is added once.
  const latest = { mode, shown, skip: !!skip, togglePlay, skipNow, exit, goNext, seek, poke, closePanel };
  const keys = useRef(latest);
  useEffect(() => {
    keys.current = latest;
  });

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const k = keys.current;
      const media = mediaKey(event);
      const back = isBack(event);
      if (!media && !back && !ARROWS.has(event.key) && event.key !== "Enter") return;
      // Ahead of the spatial navigation and of the TV frame's own Back.
      const take = () => {
        event.preventDefault();
        event.stopImmediatePropagation();
      };
      if (back) {
        take();
        if (k.mode === "panel") k.closePanel();
        else k.exit();
        return;
      }
      if (media) {
        take();
        const v = video.current;
        if (media === "stop") return k.exit();
        if (media === "next") return k.goNext();
        // On the end card play means the next episode; nothing else should restart the one that ended.
        if (k.mode === "ended") {
          if (media === "play" || media === "playPause") k.goNext();
          return;
        }
        if (media === "playPause") k.togglePlay();
        else if (media === "play") void v?.play().catch(() => undefined);
        else if (media === "pause") v?.pause();
        else k.seek.nudge(media === "forward" ? 1 : -1);
        if (k.mode === "controls") {
          if (!k.shown) setFocus(SEEK_KEY);
          k.poke();
        }
        return;
      }
      if (k.mode !== "controls") return;
      if (k.shown) {
        k.poke();
        return;
      }
      // Hidden controls: the first press acts at once and brings them up on the timeline.
      take();
      if (event.key === "Enter") {
        if (k.skip) return k.skipNow();
        k.togglePlay();
      } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        k.seek.nudge(event.key === "ArrowRight" ? 1 : -1);
      }
      setFocus(SEEK_KEY);
      k.poke();
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // When the controls take the remote back: the button that opened a panel, else the timeline
  // (on arrival, after a card).
  const lastPanel = useRef<Panel | null>(null);
  useEffect(() => {
    if (panel) {
      lastPanel.current = panel;
      return;
    }
    if (mode !== "controls") return;
    const from = lastPanel.current;
    lastPanel.current = null;
    setFocus(from ? PANEL_BUTTON[from] : SEEK_KEY);
  }, [mode, panel]);

  function onLoadedMetadata() {
    const v = video.current;
    if (!v) return;
    setDuration(v.duration);
    setAskStreams(true);
    if (!started.current) {
      started.current = true;
      const from = attempt > 0 ? current : startAt;
      if (from > 0 && from < v.duration) v.currentTime = from;
    }
  }

  function onEnded(e: React.SyntheticEvent<HTMLVideoElement>) {
    setPlaying(false);
    setEnded(true);
    save(e.currentTarget);
    if (next !== undefined && autoNext) setCountdown(NEXT_COUNTDOWN);
  }

  const subtitleNames = trackNames(tracks, locale);
  const sections: Record<Panel, MenuSection[]> = {
    subtitles: [
      {
        title: tv("subtitleLanguage"),
        options: [
          { key: "sub-off", label: t("subtitlesOff"), selected: selected < 0, onPick: () => subtitles.chooseTrack(-1) },
          ...subtitleNames.map((name, i) => ({ key: `sub-${i}`, label: name, selected: selected === i, onPick: () => subtitles.chooseTrack(i) })),
        ],
      },
      {
        title: t("settings.size"),
        options: SIZES.map((size) => ({
          key: `size-${size}`,
          label: t(`settings.sizes.${size}`),
          selected: style.subtitle_size === size,
          onPick: () => subtitles.changeStyle({ ...style, subtitle_size: size }),
        })),
      },
      {
        title: tv("subtitleLook"),
        // Only tracks that come styled have a choice to make.
        options: styled
          ? [
              { key: "look-styled", label: tv("styled"), selected: !plain, onPick: () => setPlain(false) },
              { key: "look-plain", label: tv("plain"), selected: plain, onPick: () => setPlain(true) },
            ]
          : [],
      },
    ],
    audio: [
      {
        title: t("audio"),
        options: audioNames.map((a) => ({ key: `audio-${a.id}`, label: a.label, selected: hls.audioTrack === a.id, onPick: () => chooseAudio(a.id) })),
      },
    ],
    source: [
      {
        title: t("source"),
        options: streams.map((s) => ({
          key: `stream-${s.source}-${s.lang}`,
          label: streamLabel(names, s),
          selected: sameStream(s, picked),
          onPick: () => switchStream(s),
        })),
      },
      {
        title: t("settings.quality"),
        options:
          hls.qualities.length > 1
            ? [
                { key: "quality-auto", label: t("settings.auto"), selected: hls.quality < 0, onPick: () => hls.chooseQuality(-1) },
                ...hls.qualities.map((q) => ({
                  key: `quality-${q.index}`,
                  label: t("settings.height", { height: q.height }),
                  selected: hls.quality === q.index,
                  onPick: () => hls.chooseQuality(q.index),
                })),
              ]
            : [],
      },
    ],
  };
  const panelTitle: Record<Panel, string> = { subtitles: t("subtitles"), audio: t("audio"), source: t("source") };
  const others = streams.filter((s) => !sameStream(s, { source, lang }));
  const sourceLine = automatic ? t("autoPlaying", { stream: playingName }) : playingName;

  return (
    <div
      role="region"
      aria-label={t("region")}
      onMouseMove={poke}
      className={`fixed inset-0 z-[60] bg-black text-fg ${shown ? "" : "cursor-none"}`}
    >
      <video
        ref={video}
        src={kind === "mp4" ? (url ?? undefined) : undefined}
        autoPlay
        playsInline
        onClick={togglePlay}
        onLoadedMetadata={onLoadedMetadata}
        onDurationChange={() => video.current && setDuration(video.current.duration)}
        onTimeUpdate={(e) => {
          setCurrent(e.currentTarget.currentTime);
          onTime(e.currentTarget);
        }}
        onPlay={() => {
          setPlaying(true);
          setEnded(false);
          setCountdown(null);
          poke();
        }}
        onPause={(e) => {
          setPlaying(false);
          save(e.currentTarget);
        }}
        onEnded={onEnded}
        onWaiting={() => setWaiting(true)}
        onCanPlay={() => setWaiting(false)}
        onPlaying={() => setWaiting(false)}
        onError={() => url && setError("playback_failed")}
        className="absolute inset-0 h-full w-full"
      >
        {tracks.map((track) => (
          <track key={track.url} kind="subtitles" src={`/api/proxy${track.url}`} srcLang={track.lang} label={track.label} />
        ))}
      </video>

      {drawStyled && <AssSubtitles key={drawStyled} video={video} url={`/api/proxy${drawStyled}`} fonts={fonts} onFail={subtitles.onAssFail} />}

      <SubtitleOverlay
        video={video}
        draw={!drawStyled}
        selected={selected}
        tracksKey={tracks.map((track) => track.url).join()}
        style={style}
        controlsShown={shown && mode === "controls"}
        controlsHeight={CONTROLS_HEIGHT}
      />

      {!error && waiting && !ended && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center" role="status">
          <span className="h-20 w-20 animate-spin rounded-full border-[6px] border-line-strong border-t-accent" />
          <span className="sr-only">{t("loading")}</span>
        </div>
      )}

      {error && (
        <TvPlayerError error={error} onRetry={retry} onExit={exit} others={others} names={names} onSwitch={switchStream} />
      )}

      {ended && !error && (
        <TvEndCard
          next={next}
          countdown={countdown}
          autoNext={autoNext}
          onPlayNext={goNext}
          onCancelCountdown={() => setCountdown(null)}
          onExit={exit}
        />
      )}

      {skip && !error && !ended && !panel && (
        <div className="absolute right-[var(--tv-x)]" style={{ bottom: shown ? `calc(${CONTROLS_HEIGHT} + 1rem)` : "4rem" }}>
          {shown ? (
            <TvControl focusKey="tvp-skip" label={t(skipKey(skip.kind))} onPress={skipNow} />
          ) : (
            // Hidden controls: OK skips, so the pill looks pressed-ready.
            <span className="inline-flex min-h-[4.5rem] items-center rounded-full border-2 border-accent bg-accent px-8 text-[1.625rem] font-bold text-on-accent">
              {t(skipKey(skip.kind))}
            </span>
          )}
        </div>
      )}

      {!error && !ended && (
        <div
          aria-hidden={!shown}
          className={`pointer-events-none absolute inset-0 transition-opacity duration-[160ms] ease-out ${shown ? "opacity-100" : "opacity-0"}`}
        >
          {/* Player-only exception to the flat rule: a soft dark fade keeps text readable on any picture. */}
          <div className="absolute inset-x-0 top-0 h-[16rem] bg-gradient-to-b from-black/80 to-transparent" />
          <div className="absolute inset-x-0 bottom-0 h-[22rem] bg-gradient-to-t from-black/90 via-black/60 to-transparent" />
          <div className="absolute left-[var(--tv-x)] right-[var(--tv-x)] top-12 flex items-baseline gap-6">
            <p className="min-w-0 truncate font-display text-[4rem] leading-tight">{title}</p>
            <p className="shrink-0 text-[2.25rem] font-bold text-soft">{t("episode", { episode })}</p>
          </div>
          <div className={`absolute inset-x-[var(--tv-x)] bottom-20 ${shown ? "pointer-events-auto" : ""}`}>
            <TvSeekBar current={current} duration={duration} target={seek.target} onNudge={seek.nudge} onEnter={togglePlay} />
            <div className="mt-4 flex items-center gap-6">
              <TvControl focusKey={PLAY_KEY} round icon={playing ? "pause" : "play"} label={playing ? t("pause") : t("play")} onPress={togglePlay} />
              <TvControl focusKey="tvp-rewind" round icon="rewind" label={t("rewind")} onPress={() => seek.nudge(-1)} />
              <TvControl focusKey="tvp-forward" round icon="forward" label={t("forward")} onPress={() => seek.nudge(1)} />
              {next !== undefined && <TvControl focusKey="tvp-next" icon="next" label={t("nextShort")} onPress={goNext} />}
              <p className="mx-4 min-w-0 flex-1 truncate text-right text-[1.375rem] text-soft">{sourceLine}</p>
              <div className="flex shrink-0 items-center gap-6">
                {tracks.length > 0 && <TvControl focusKey="tvp-subtitles" label={t("subtitles")} onPress={() => setPanel("subtitles")} />}
                {audioNames.length > 1 && <TvControl focusKey="tvp-audio" label={t("audio")} onPress={() => setPanel("audio")} />}
                <TvControl focusKey="tvp-source" label={t("source")} onPress={() => setPanel("source")} />
              </div>
            </div>
          </div>
        </div>
      )}

      {panel && !error && <TvPlayerMenu title={panelTitle[panel]} sections={sections[panel]} empty={tv("nothingElse")} />}
    </div>
  );
}

function skipKey(kind: string) {
  return kind === "intro" ? "skipIntro" : kind === "recap" ? "skipRecap" : "skipOutro";
}
