"use client";

import { errorCode } from "@app/api-client";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useToast } from "@/components/ui/Toast";
import { Link, useRouter } from "@/i18n/navigation";
import { api } from "@/lib/api";
import { watchHref, type Lang, type StreamChoice } from "@/lib/watch-target";

import { useRoomSync, type RoomBinding } from "@/components/room/useRoomSync";

import { setAutoNext, useAutoNext } from "./autoNext";
import { stageOf } from "./FullscreenStage";
import type { WebkitVideo } from "./SubtitleOverlay";
import { PlayerIcon } from "./icons";
import { languageName, trackNames } from "./languages";
import { formatTime } from "./progress";
import { levelsToDrop, qualityList } from "./qualities";
import { SettingsMenu, type AudioTrack, type Quality } from "./SettingsMenu";
import { sameStream, streamLabel, type StreamNames } from "./streams";
import { activeSkip, mergeSkips, type Skip } from "./skips";
import { AssSubtitles } from "./AssSubtitles";
import { SubtitleOverlay } from "./SubtitleOverlay";
import type { SubtitleStyle } from "./subtitleStyle";
import { useProgressSaver } from "./useProgressSaver";

export type { Lang };

type Props = {
  source: string;
  animeId: number;
  episode: number;
  title: string;
  /** Sorted episode numbers the source has, used for the next episode. May be empty. */
  episodes: number[];
  lang: Lang;
  /** Seconds to start from: the saved position, or where a source or sub/dub switch left off. */
  startAt: number;
  /** Saved subtitle choice: a language code, "off", or null for automatic. */
  subtitleLang: string | null;
  /** Saved look of the subtitles. */
  subtitleStyle: SubtitleStyle;
  /** Set when watching together: the room drives playback and picks the next episode. */
  room?: RoomBinding;
};

type Track = { lang: string; label: string; url: string; ass_url?: string | null };

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const SEEK_STEP = 10;
const VOLUME_STEP = 0.1;
const HIDE_CONTROLS_MS = 3000;
export const NEXT_COUNTDOWN = 10;
const ERRORS = [
  "not_available",
  "source_not_found",
  "upstream_failed",
  "playback_failed",
  "network",
  "too_many_rooms",
  "anime_not_found",
  "room_full",
];

/** The audio track matching the source's default (by name or language), else the first. */
export function pickAudio(tracks: { id: number; name: string; lang?: string }[], wanted: string | null): number {
  const target = wanted?.toLowerCase();
  const match = target && tracks.find((a) => a.name.toLowerCase() === target || a.lang?.toLowerCase() === target);
  return match ? match.id : (tracks[0]?.id ?? -1);
}

/** The track to show: the saved language if this episode has it, else Portuguese, then English. */
export function pickTrack(tracks: Track[], preference: string | null): number {
  if (preference === "off") return -1;
  for (const wanted of [preference, "pt-BR", "pt", "en"]) {
    const index = tracks.findIndex((t) => t.lang === wanted);
    if (wanted && index >= 0) return index;
  }
  return -1;
}

export function Player(props: Props) {
  const { source, animeId, episode, title, episodes, lang, startAt, subtitleLang } = props;
  const t = useTranslations("player");
  const locale = useLocale();
  const router = useRouter();
  const toast = useToast();
  // Full screen goes to the watch layout's stage around this, which outlives the episode,
  // so it survives auto-next.
  const stage = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<import("hls.js").default | null>(null);
  const started = useRef(false);
  const hevcUsed = useRef(false);
  const hevcFailed = useRef(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const [attempt, setAttempt] = useState(0);
  const [url, setUrl] = useState<string | null>(null);
  const [kind, setKind] = useState<string>("mp4");
  const [tracks, setTracks] = useState<Track[]>([]);
  // Fonts for the styled subtitles, through the proxy like the tracks.
  const [fonts, setFonts] = useState<Record<string, string>>({});
  // Set when styled subtitles can't be drawn here; the WebVTT copies are shown instead.
  const [assFailed, setAssFailed] = useState(false);
  // The source that answered; another enabled one when the requested source failed.
  const [answered, setAnswered] = useState(source);
  const [ownSkips, setOwnSkips] = useState<Skip[]>([]);
  // From AniSkip, for what the source didn't give; asked once the episode's length is known.
  const [extraSkips, setExtraSkips] = useState<Skip[]>([]);
  const [defaultAudio, setDefaultAudio] = useState<string | null>(null);
  const [qualities, setQualities] = useState<Quality[]>([]);
  const [quality, setQuality] = useState(-1);
  const [audioTracks, setAudioTracks] = useState<AudioTrack[]>([]);
  const [audioTrack, setAudioTrack] = useState(-1);
  const [style, setStyle] = useState(props.subtitleStyle);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // null until the viewer picks one here; then it wins over the saved preference.
  const [chosen, setChosen] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Every source and sub/dub that has this episode, for the source menu.
  const [streams, setStreams] = useState<StreamChoice[]>([]);
  const [playing, setPlaying] = useState(false);
  const [waiting, setWaiting] = useState(true);
  const [current, setCurrent] = useState(startAt);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [rate, setRate] = useState(1);
  const [fullscreen, setFullscreen] = useState(false);
  const [active, setActive] = useState(true);
  const [ended, setEnded] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const autoNext = useAutoNext();

  const subtitleNames = trackNames(tracks, locale);
  const names: StreamNames = { has: (key) => t.has(key), t: (key, values) => t(key, values) };
  const playingFrom: StreamChoice = { source: answered, lang };
  // In a room only the host moves everyone to another stream.
  const canSwitchStream = !props.room || props.room.switchStream !== undefined;
  const audioNames = audioTracks.map((a) => ({ ...a, label: languageName(a.lang, locale) ?? a.label }));

  const next = episodes.find((e) => e > episode);
  const backHref = `/anime/${animeId}`;
  const { save, onTime } = useProgressSaver(video, animeId, episode);
  const { room } = props;
  const sync = useRoomSync(
    {
      read: () => (video.current && video.current.readyState >= 1 ? video.current : null),
      seek: (seconds) => {
        if (video.current) video.current.currentTime = seconds;
      },
      play: () => void video.current?.play().catch(() => undefined),
      pause: () => video.current?.pause(),
    },
    room,
  );

  useEffect(() => {
    let cancelled = false;
    api
      .POST("/watch/{source}/{anime_id}/episodes/{episode}/play", {
        params: { path: { source, anime_id: animeId, episode }, query: { lang } },
      })
      .then(({ data, error: body }) => {
        if (cancelled) return;
        if (data) {
          setKind(data.kind);
          setAnswered(data.source);
          setOwnSkips(data.skips ?? []);
          setExtraSkips([]);
          setDefaultAudio(data.default_audio ?? null);
          setTracks(data.subtitles ?? []);
          setFonts(Object.fromEntries(Object.entries(data.fonts ?? {}).map(([name, link]) => [name, `/api/proxy${link}`])));
          setAssFailed(false);
          setChosen(null);
          setUrl(`/api/proxy${data.url}`);
        }
        else setError(errorCode(body));
      })
      .catch(() => !cancelled && setError("network"));
    return () => {
      cancelled = true;
    };
  }, [source, animeId, episode, lang, attempt]);

  useEffect(() => {
    let cancelled = false;
    api
      .GET("/watch/options/{anime_id}/{episode}", { params: { path: { anime_id: animeId, episode } } })
      .then(({ data }) => !cancelled && data && setStreams(data))
      // Without the list the menu just has nothing to switch to.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [animeId, episode]);

  // Whole seconds, so the small corrections players make to the length don't ask again.
  const length = url && Number.isFinite(duration) && duration > 0 ? Math.round(duration) : 0;
  useEffect(() => {
    if (!length) return;
    let cancelled = false;
    api
      .GET("/watch/skips/{anime_id}/{episode}", {
        params: { path: { anime_id: animeId, episode }, query: { length } },
      })
      .then(({ data }) => !cancelled && data && setExtraSkips(data))
      // Without them only the source's own skips are offered.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [animeId, episode, length]);
  const skips = useMemo(() => mergeSkips(ownSkips, extraSkips), [ownSkips, extraSkips]);

  const [preference, setPreference] = useState(subtitleLang);
  const selected = chosen ?? pickTrack(tracks, preference);
  const styled = assFailed ? null : tracks[selected]?.ass_url;
  const onAssFail = useCallback(() => setAssFailed(true), []);

  function chooseTrack(index: number) {
    setChosen(index);
    const lang = index < 0 ? "off" : tracks[index].lang;
    setPreference(lang);
    if (lang === "und") return;
    // Best effort: the choice only matters again on the next episode.
    void api.PATCH("/me", { body: { subtitle_lang: lang } }).catch(() => undefined);
  }

  function changeStyle(next: SubtitleStyle) {
    setStyle(next);
    // Best effort, like the subtitle language: the look still applies to this episode.
    void api.PUT("/watch/preferences", { body: next }).catch(() => undefined);
  }

  function chooseQuality(index: number) {
    setQuality(index);
    if (hlsRef.current) hlsRef.current.currentLevel = index;
  }

  function chooseAudio(id: number) {
    setAudioTrack(id);
    if (hlsRef.current) hlsRef.current.audioTrack = id;
  }

  // hls.js wherever it works (one code path, so tracks behave the same); native HLS only
  // where it can't run, e.g. iPhone Safari.
  useEffect(() => {
    const v = video.current;
    if (!v || !url || kind !== "hls") return;
    let hls: import("hls.js").default | undefined;
    let cancelled = false;
    void import("hls.js").then(({ default: Hls }) => {
      if (cancelled) return;
      if (Hls.isSupported()) {
        let recovered = false;
        hls = new Hls();
        hlsRef.current = hls;
        hls.on(Hls.Events.MANIFEST_PARSED, (_event, data) => {
          // Play the original HEVC when this device decodes it; if it then fails, retry with H.264.
          if (!hevcFailed.current) {
            const drop = levelsToDrop(data.levels);
            hevcUsed.current = drop.length > 0;
            for (const i of drop.reverse()) hls?.removeLevel(i);
          }
          setQualities(qualityList(hls?.levels ?? data.levels));
        });
        hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, (_event, data) => {
          const found = data.audioTracks.map((a) => ({ id: a.id, name: a.name, lang: a.lang }));
          setAudioTracks(found.map((a) => ({ id: a.id, label: a.name || a.lang || String(a.id + 1), lang: a.lang })));
          const id = pickAudio(found, defaultAudio);
          if (hls && id >= 0 && hls.audioTrack !== id) hls.audioTrack = id;
          setAudioTrack(id);
        });
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (!data.fatal) return;
          if (hevcUsed.current) {
            hevcUsed.current = false;
            hevcFailed.current = true;
            retry();
          } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !recovered) {
            recovered = true;
            hls?.recoverMediaError();
          } else setError("playback_failed");
        });
        hls.loadSource(url);
        hls.attachMedia(v);
      } else if (v.canPlayType("application/vnd.apple.mpegurl")) {
        v.src = url;
      } else setError("playback_failed");
    });
    return () => {
      cancelled = true;
      hls?.destroy();
      hlsRef.current = null;
      setQualities([]);
      setQuality(-1);
      setAudioTracks([]);
    };
    // defaultAudio arrives with the url, in the same response.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, kind]);

  const goNext = useCallback(() => {
    if (next === undefined) return;
    // In a room the next episode is a vote, and the room moves everyone together.
    if (room) void room.pickEpisode(next);
    else router.push(watchHref(source, animeId, next, lang));
  }, [next, router, source, animeId, lang, room]);

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

  useEffect(() => {
    const onChange = () => setFullscreen(!!stage.current && document.fullscreenElement === stageOf(stage.current));
    onChange();
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const togglePlay = useCallback(() => {
    const v = video.current;
    if (!v || !url) return;
    if (v.paused || v.ended) void v.play().catch(() => undefined);
    else v.pause();
  }, [url]);

  const seekBy = useCallback((delta: number) => {
    const v = video.current;
    if (v && Number.isFinite(v.duration)) v.currentTime = Math.min(Math.max(v.currentTime + delta, 0), v.duration);
  }, []);

  const changeVolume = useCallback((delta: number) => {
    const v = video.current;
    if (!v) return;
    v.volume = Math.round(Math.min(Math.max(v.volume + delta, 0), 1) * 100) / 100;
    v.muted = v.volume === 0;
  }, []);

  const toggleMute = useCallback(() => {
    const v = video.current;
    if (!v) return;
    v.muted = !v.muted;
    if (!v.muted && v.volume === 0) v.volume = 0.5;
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
      return;
    }
    const el = stageOf(stage.current);
    if (el?.requestFullscreen) void el.requestFullscreen().catch(() => undefined);
    // iPhone Safari can only full-screen a <video>, with its own controls and subtitles.
    else (video.current as WebkitVideo | null)?.webkitEnterFullscreen?.();
  }, []);

  const skip = activeSkip(skips, current);
  const skipNow = useCallback(() => {
    const v = video.current;
    const target = activeSkip(skips, v?.currentTime ?? 0);
    if (v && target) v.currentTime = target.end;
  }, [skips]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target as HTMLElement;
      const tag = target.tagName;
      if (tag === "SELECT" || tag === "TEXTAREA" || (tag === "INPUT" && (target as HTMLInputElement).type !== "range")) {
        return;
      }
      const onButton = tag === "BUTTON" || tag === "A";
      switch (e.key) {
        case " ":
          // A focused button or link handles Space itself.
          if (onButton) return;
          togglePlay();
          break;
        case "k":
          togglePlay();
          break;
        case "ArrowLeft":
          seekBy(-SEEK_STEP);
          break;
        case "ArrowRight":
          seekBy(SEEK_STEP);
          break;
        case "ArrowUp":
          changeVolume(VOLUME_STEP);
          break;
        case "ArrowDown":
          changeVolume(-VOLUME_STEP);
          break;
        case "f":
          toggleFullscreen();
          break;
        case "m":
          toggleMute();
          break;
        case "n":
          goNext();
          break;
        case "s":
          skipNow();
          break;
        case "Escape":
          if (!settingsOpen) return;
          setSettingsOpen(false);
          break;
        default:
          return;
      }
      e.preventDefault();
      poke();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePlay, seekBy, changeVolume, toggleFullscreen, toggleMute, goNext, skipNow, settingsOpen, poke]);

  function switchStream(to: StreamChoice) {
    setSettingsOpen(false);
    if (sameStream(to, playingFrom) && !error) return;
    // What was asked for already: a fallback answered or it failed, so ask again.
    if (sameStream(to, { source, lang })) {
      retry();
      return;
    }
    // Best effort: the title opens from here next time.
    void api.PUT("/watch/choice/{anime_id}", { params: { path: { anime_id: animeId } }, body: to }).catch(() => undefined);
    // The room reloads everyone's player at the room's position.
    if (room?.switchStream) {
      void room.switchStream(to);
      return;
    }
    router.replace(watchHref(to.source, animeId, episode, to.lang, video.current?.currentTime ?? current));
  }

  async function startRoom() {
    const { data, error: body } = await api
      .POST("/watch/rooms", { body: { source, anime_id: animeId, title, episode, lang } })
      .catch(() => ({ data: undefined, error: { error: { code: "network" } } }));
    if (data) router.push(`/room/${data.code}`);
    else toast(t(`errors.${ERRORS.includes(errorCode(body)) ? errorCode(body) : "unknown"}`), "error");
  }

  function retry() {
    setError(null);
    setUrl(null);
    started.current = false;
    setAttempt((a) => a + 1);
  }

  function onLoadedMetadata() {
    const v = video.current;
    if (!v) return;
    setDuration(v.duration);
    sync.onLoadedMetadata();
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

  const others = streams.filter((s) => !sameStream(s, { source, lang }));
  const shown = active || !playing || ended || settingsOpen || error !== null;
  const errorText = error && t(`errors.${ERRORS.includes(error) ? error : "unknown"}`);
  const iconButton = "press flex h-11 w-11 items-center justify-center rounded-full text-fg hover:bg-white/10 active:bg-white/10";

  return (
    <div
      ref={stage}
      role="region"
      aria-label={t("region")}
      onMouseMove={poke}
      onTouchStart={poke}
      className={`fixed inset-0 z-[60] bg-black text-fg ${shown ? "" : "cursor-none"}`}
    >
      <video
        ref={video}
        src={kind === "mp4" ? (url ?? undefined) : undefined}
        autoPlay={!room}
        playsInline
        onClick={togglePlay}
        onDoubleClick={toggleFullscreen}
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
          sync.onPlay();
        }}
        onPause={(e) => {
          setPlaying(false);
          save(e.currentTarget);
          // The pause at the end of an episode is the video finishing, not someone pausing.
          if (!e.currentTarget.ended) sync.onPause();
        }}
        onSeeked={sync.onSeeked}
        onEnded={onEnded}
        onWaiting={() => {
          setWaiting(true);
          sync.onWaiting();
        }}
        onCanPlay={() => {
          setWaiting(false);
          sync.onReady();
        }}
        onPlaying={() => {
          setWaiting(false);
          sync.onReady();
        }}
        onVolumeChange={() => {
          if (!video.current) return;
          setVolume(video.current.volume);
          setMuted(video.current.muted);
        }}
        onRateChange={() => video.current && setRate(video.current.playbackRate)}
        onError={() => url && setError("playback_failed")}
        className="absolute inset-0 h-full w-full"
      >
        {tracks.map((track) => (
          <track key={track.url} kind="subtitles" src={`/api/proxy${track.url}`} srcLang={track.lang} label={track.label} />
        ))}
      </video>

      {styled && <AssSubtitles key={styled} video={video} url={`/api/proxy${styled}`} fonts={fonts} onFail={onAssFail} />}

      <SubtitleOverlay
        video={video}
        draw={!styled}
        selected={selected}
        tracksKey={tracks.map((track) => track.url).join()}
        style={style}
        controlsShown={shown && !error}
      />

      {!error && waiting && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center" role="status">
          <span className="h-12 w-12 animate-spin rounded-full border-4 border-white/20 border-t-accent" />
          <span className="sr-only">{t("loading")}</span>
        </div>
      )}

      {error && (
        <div className="absolute inset-0 flex items-center justify-center p-6">
          <div role="alert" className="max-w-md text-center">
            <p className="text-lg font-medium">{errorText}</p>
            <div className="mt-6 flex justify-center gap-3">
              {error !== "source_not_found" && error !== "not_available" && (
                <button type="button" onClick={retry} className="press inline-flex min-h-11 items-center justify-center rounded-full bg-accent px-5 py-2 text-sm font-bold text-on-accent">
                  {t("retry")}
                </button>
              )}
              <Link href={backHref} className="press inline-flex min-h-11 items-center justify-center rounded-full border border-line-strong px-5 py-2 text-sm font-bold">
                {t("back")}
              </Link>
            </div>
            {canSwitchStream && others.length > 0 && (
              <div className="mt-6">
                <p className="text-sm text-muted">{t("tryAnotherSource")}</p>
                <div className="mt-3 flex flex-wrap justify-center gap-2">
                  {others.map((s) => (
                    <button
                      key={`${s.source}-${s.lang}`}
                      type="button"
                      onClick={() => switchStream(s)}
                      className="press inline-flex min-h-11 items-center justify-center rounded-full border border-line-strong px-5 py-2 text-sm font-bold"
                    >
                      {streamLabel(names, s)}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      <div
        className={`pointer-events-none absolute inset-0 flex flex-col justify-between pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] pt-[env(safe-area-inset-top)] transition-opacity duration-300 ${shown ? "opacity-100" : "opacity-0"}`}
      >
        <div className="pointer-events-auto flex items-center gap-3 bg-gradient-to-b from-black/80 to-transparent px-4 pb-10 pt-4 sm:px-8">
          <Link href={backHref} aria-label={t("back")} className={iconButton}>
            <PlayerIcon name="back" />
          </Link>
          <div className="min-w-0">
            <p className="truncate font-display text-xl leading-tight">{title}</p>
            <p className="text-sm text-muted">
              {t("episode", { episode })}
              {answered !== source && (
                <span className="ml-2">· {t("fallbackSource", { source: streamLabel(names, playingFrom) })}</span>
              )}
            </p>
          </div>
          {room ? (
            room.topBar
          ) : (
            <button
              type="button"
              onClick={() => void startRoom()}
              aria-label={t("watchTogether")}
              className="press ml-auto flex h-11 items-center gap-2 rounded-full border border-white/25 px-4 text-fg hover:bg-white/10"
            >
              <PlayerIcon name="people" />
              <span className="text-sm font-bold">{t("watchTogether")}</span>
            </button>
          )}
        </div>

        {!error && (
          <div className="pointer-events-auto bg-gradient-to-t from-black/80 to-transparent px-4 pb-4 pt-10 sm:px-8">
            <div className="flex items-center gap-3 text-xs tabular-nums text-muted">
              <span>{formatTime(current)}</span>
              <input
                type="range"
                aria-label={t("seek")}
                aria-valuetext={`${formatTime(current)} / ${formatTime(duration)}`}
                min={0}
                max={duration || 0}
                step={1}
                value={Math.min(current, duration || 0)}
                onChange={(e) => {
                  const v = video.current;
                  if (v) v.currentTime = Number(e.target.value);
                  setCurrent(Number(e.target.value));
                }}
                className="h-1 flex-1 cursor-pointer accent-accent"
              />
              <span>{formatTime(duration)}</span>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-1 sm:gap-2">
              <button type="button" onClick={togglePlay} aria-label={playing ? t("pause") : t("play")} className={iconButton}>
                <PlayerIcon name={playing ? "pause" : "play"} />
              </button>
              <button type="button" onClick={() => seekBy(-SEEK_STEP)} aria-label={t("rewind")} className={iconButton}>
                <PlayerIcon name="rewind" />
              </button>
              <button type="button" onClick={() => seekBy(SEEK_STEP)} aria-label={t("forward")} className={iconButton}>
                <PlayerIcon name="forward" />
              </button>
              <button
                type="button"
                onClick={toggleMute}
                aria-label={muted ? t("unmute") : t("mute")}
                className={iconButton}
              >
                <PlayerIcon name={muted || volume === 0 ? "muted" : "volume"} />
              </button>
              <input
                type="range"
                aria-label={t("volume")}
                min={0}
                max={1}
                step={0.05}
                value={muted ? 0 : volume}
                onChange={(e) => {
                  const v = video.current;
                  if (!v) return;
                  v.volume = Number(e.target.value);
                  v.muted = v.volume === 0;
                }}
                className="hidden w-24 cursor-pointer accent-accent sm:block"
              />
              <span className="flex-1" />
              <button
                type="button"
                onClick={() => setSettingsOpen((o) => !o)}
                aria-label={t("settings.title")}
                aria-expanded={settingsOpen}
                className={iconButton}
              >
                <PlayerIcon name="settings" />
              </button>
              {next !== undefined && (
                <button
                  type="button"
                  onClick={goNext}
                  aria-label={t("next")}
                  className="press flex h-11 items-center gap-2 rounded-full px-3 text-fg hover:bg-white/10 sm:px-4"
                >
                  <PlayerIcon name="next" />
                  <span className="hidden text-sm font-bold sm:inline">{t("nextShort")}</span>
                </button>
              )}
              <button
                type="button"
                onClick={toggleFullscreen}
                aria-label={fullscreen ? t("exitFullscreen") : t("fullscreen")}
                className={iconButton}
              >
                <PlayerIcon name={fullscreen ? "exitFullscreen" : "fullscreen"} />
              </button>
            </div>
            <p className="sr-only">{t("shortcuts")}</p>
          </div>
        )}
      </div>

      {room?.overlay}

      {settingsOpen && !error && (
        <>
          <button
            type="button"
            tabIndex={-1}
            aria-hidden="true"
            onClick={() => setSettingsOpen(false)}
            className="absolute inset-0 cursor-default"
          />
          <SettingsMenu
            qualities={qualities}
            quality={quality}
            onQuality={chooseQuality}
            audioTracks={audioNames}
            audioTrack={audioTrack}
            onAudioTrack={chooseAudio}
            streams={canSwitchStream ? streams.map((s) => streamLabel(names, s)) : []}
            stream={streams.findIndex((s) => sameStream(s, playingFrom))}
            onStream={(index) => switchStream(streams[index])}
            streamName={streamLabel(names, playingFrom)}
            subtitleNames={subtitleNames}
            subtitle={selected}
            onSubtitle={chooseTrack}
            speeds={SPEEDS}
            rate={rate}
            onRate={(r) => {
              if (video.current) video.current.playbackRate = r;
            }}
            style={style}
            onStyle={changeStyle}
            onClose={() => setSettingsOpen(false)}
          />
        </>
      )}

      {skip && !error && !ended && !settingsOpen && (
        <button
          type="button"
          onClick={skipNow}
          className="press absolute bottom-28 right-4 min-h-11 rounded-full border border-white/40 bg-black/70 px-5 py-2.5 text-sm font-bold text-fg hover:bg-black/90 sm:right-8"
        >
          {t(skip.kind === "intro" ? "skipIntro" : skip.kind === "recap" ? "skipRecap" : "skipOutro")}
        </button>
      )}

      {ended && !error && (
        <div className="pop-in absolute bottom-28 right-4 w-[min(22rem,calc(100%-2rem))] origin-bottom-right rounded-ui border border-line bg-surface p-4 shadow-lg sm:right-8">
          {next !== undefined ? (
            <>
              <p className="font-medium" aria-live="polite">
                {countdown !== null ? t("nextIn", { episode: next, seconds: countdown }) : t("nextReady", { episode: next })}
              </p>
              <div className="mt-4 flex flex-wrap gap-2">
                <button type="button" onClick={goNext} className="press inline-flex min-h-11 items-center justify-center rounded-full bg-accent px-5 py-2 text-sm font-bold text-on-accent">
                  {t("playNow")}
                </button>
                {countdown !== null && (
                  <button
                    type="button"
                    onClick={() => setCountdown(null)}
                    className="press inline-flex min-h-11 items-center justify-center rounded-full border border-line-strong px-5 py-2 text-sm font-bold"
                  >
                    {t("cancel")}
                  </button>
                )}
              </div>
              <label className="mt-4 flex items-center gap-2 text-sm text-muted">
                <input
                  type="checkbox"
                  checked={autoNext}
                  onChange={(e) => {
                    setAutoNext(e.target.checked);
                    if (!e.target.checked) setCountdown(null);
                  }}
                  className="accent-accent"
                />
                {t("autoNext")}
              </label>
            </>
          ) : (
            <>
              <p className="font-medium">{t("finished")}</p>
              <Link href={backHref} className="mt-4 press inline-flex min-h-11 items-center justify-center rounded-full bg-accent px-5 py-2 text-sm font-bold text-on-accent">
                {t("back")}
              </Link>
            </>
          )}
        </div>
      )}
    </div>
  );
}
