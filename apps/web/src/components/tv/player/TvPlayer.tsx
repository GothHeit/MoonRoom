"use client";

import type { components } from "@app/api-client";
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
import { useLanguageSwitch } from "@/components/player/useLanguageSwitch";
import { warmLanguages } from "@/components/player/useLanguages";
import { useSubtitles } from "@/components/player/useSubtitles";
import { togglePlayback } from "@/components/player/useVideoControls";
import { useFollowFallback } from "@/components/room/useFollowFallback";
import { useRoomSync, type RoomBinding } from "@/components/room/useRoomSync";
import { useRouter } from "@/i18n/navigation";
import { api } from "@/lib/api";
import { AUTO_SOURCE } from "@/lib/pick-stream";
import { warmPlayback } from "@/lib/warm-playback";
import { watchHref, type Lang, type StreamChoice } from "@/lib/watch-target";

import { isBack, mediaKey, registerMediaKeys } from "../keys";
import { tvHref } from "../paths";
import { setFocus } from "../spatial";
import { useTvSeek } from "./seek";
import { TvEndCard, TvJoinCard, TvPlayerError } from "./TvPlayerCards";
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
  /** Episode stills the source has, by episode number. */
  thumbnails: Record<string, string>;
  /** The title's poster, behind the end screen when there's no wide art. */
  poster: string | null;
  lang: Lang;
  /** Audio to start on for this play ("original" or a dub's language), set by the Language menu. */
  audio?: string;
  /** Seconds to start from: the saved position, or where a source switch left off. */
  startAt: number;
  /** Saved subtitle choice: a language code, "off", or null for automatic. */
  subtitleLang: string | null;
  subtitleStyle: SubtitleStyle;
  showSkips: boolean;
  /** Set when watching together: the room drives playback and picks the next episode. */
  room?: RoomBinding;
};

type Panel = "language" | "subtitles" | "audio" | "source";
type TitleArt = components["schemas"]["TitleArtOut"];

// Longer than the site's 3 s: the person is across the room and the remote is slower.
const HIDE_CONTROLS_MS = 5000;
const NEXT_COUNTDOWN = 10;
const WARM_NEXT_SECONDS = 180;
const ARROWS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]);
// Room the control bar takes at the bottom, so subtitles sit above it while it shows.
const CONTROLS_HEIGHT = "16rem";

const PANEL_BUTTON: Record<Panel, string> = { language: "tvp-language", subtitles: "tvp-subtitles", audio: "tvp-audio", source: "tvp-source" };

/**
 * The TV mode's player: the same play pipeline as the site (sources with fallback, signed links,
 * subtitles, progress, skips, next episode), driven by the remote. While it plays nothing is on
 * screen; any key brings up the controls. Left and right seek, OK plays or pauses, Back
 * closes a panel or leaves, and the media keys work whenever the TV hands them over. In a room
 * the same keys ask the room, which moves everyone together.
 */
export function TvPlayer(props: Props) {
  const { source, animeId, episode, title, episodes, thumbnails, poster, lang, startAt, subtitleLang, showSkips, room } = props;
  const t = useTranslations("player");
  const tv = useTranslations("tv.player");
  const locale = useLocale();
  const router = useRouter();
  const video = useRef<HTMLVideoElement>(null);
  const started = useRef(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const playback = usePlayback(source, animeId, episode, lang, props.audio);
  const { attempt, url, kind, tracks, fonts, answered, answeredLang, ownSkips, defaultAudio, maxHeight, error, setError } = playback;
  const [panel, setPanel] = useState<Panel | null>(null);
  const [streams, setStreams] = useState<StreamChoice[]>([]);
  const [askStreams, setAskStreams] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [waiting, setWaiting] = useState(true);
  // The picture has shown at least once since the stream was asked for.
  const [begun, setBegun] = useState(false);
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
    setBegun(false);
    playbackRetry();
  }, [playbackRetry]);
  const failPlayback = useCallback(() => setError("playback_failed"), [setError]);
  const subtitles = useSubtitles(tracks, subtitleLang, props.subtitleStyle);
  const { selected, styled, style } = subtitles;
  const drawStyled = styled && !plain ? styled : null;
  const hls = useHls({
    video,
    url,
    kind,
    defaultAudio,
    maxHeight,
    onRetry: retry,
    onFail: failPlayback,
    lowMemory: true,
  });
  const seek = useTvSeek(video);
  const sync = useRoomSync(
    {
      read: () => {
        const v = video.current;
        if (!v || v.readyState < 1) return null;
        return { currentTime: v.currentTime, paused: v.paused, playbackRate: v.playbackRate, seeking: v.seeking, wireless: false };
      },
      seek: (seconds) => {
        if (video.current) video.current.currentTime = seconds;
      },
      play: () => video.current?.play() ?? Promise.resolve(),
      pause: () => video.current?.pause(),
      setRate: (rate) => {
        if (video.current) video.current.playbackRate = rate;
      },
    },
    room,
  );

  const names: StreamNames = { has: (key) => t.has(key), t: (key, values) => t(key, values) };
  const playingFrom: StreamChoice = { source: answered, lang: answeredLang };
  const automatic = source === AUTO_SOURCE;
  const picked: StreamChoice = automatic ? { source, lang } : playingFrom;
  const playingName = streamLabel(names, playingFrom);
  // In a room only the host moves everyone to another stream.
  const canSwitchStream = !room || room.switchStream !== undefined;
  // The room's stream couldn't play for the host: the room moves to the one that did.
  const following = useFollowFallback({
    room,
    animeId,
    episode,
    asked: { source, lang },
    playing: playingFrom,
    ready: url !== null,
    automatic,
  });
  const audioNames = hls.audioTracks.map((a) => ({ ...a, label: languageName(a.lang, locale) ?? a.label }));
  const titleHref = tvHref(`/anime/${animeId}`);

  const next = episodes.find((e) => e > episode);
  const nearEnd = next !== undefined && duration > 0 && current > Math.max(duration - WARM_NEXT_SECONDS, duration / 2);
  useEffect(() => {
    if (nearEnd && next !== undefined) {
      warmPlayback(source, animeId, next, lang);
      if (!room) warmLanguages(animeId, next);
    }
  }, [nearEnd, source, animeId, next, lang, room]);
  const { save, onTime } = useProgressSaver(video, animeId, episode);

  // Wide art and the next episode's still and title for the end screen, asked for near the end.
  const [art, setArt] = useState<TitleArt | null>(null);
  const artAsked = useRef(false);
  useEffect(() => {
    if (!(nearEnd || ended) || artAsked.current) return;
    let cancelled = false;
    api
      .GET("/anime/{anime_id}/art", { params: { path: { anime_id: animeId }, query: { lang: locale === "pt" ? "pt" : "en" } } })
      .then(({ data }) => {
        // Only a delivered answer counts as asked: if the episode ends while the request is in flight, the effect runs again and asks once more.
        if (cancelled || !data) return;
        artAsked.current = true;
        setArt(data);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [nearEnd, ended, animeId, locale]);

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
  // Not before the picture first shows: there is nothing to skip yet, and the pill would sit by the spinner.
  const skip = showSkips && begun ? activeSkip(skips, current) : undefined;
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
    if (next === undefined) return;
    // In a room the next episode is a vote, and the room moves everyone together.
    if (room) void room.pickEpisode(next);
    else router.replace(tvHref(watchHref(source, animeId, next, lang)));
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

  // The Language menu. A room keeps its source menu: there the host's pick has to move everyone.
  const language = useLanguageSwitch({
    animeId,
    episode,
    enabled: (askStreams || panel !== null || error !== null) && !room,
    loaded: url !== null,
    now: { audioTracks: hls.audioTracks, audioTrack: hls.audioTrack, subtitles: tracks, subtitle: selected, source: answered, lang: answeredLang },
    heights: hls.qualities.map((q) => q.height),
    chooseAudio: (id) => chooseAudio(id),
    chooseSubtitle: subtitles.chooseTrack,
    showSubtitle: subtitles.showTrack,
    position: () => video.current?.currentTime ?? current,
    reload: (href) => router.replace(tvHref(href)),
    onPicked: () => setPanel(null),
  });

  function switchStream(to: StreamChoice) {
    setPanel(null);
    if (sameStream(to, playingFrom) && !error) return;
    if (sameStream(to, { source, lang })) {
      retry();
      return;
    }
    void api.PUT("/watch/choice/{anime_id}", { params: { path: { anime_id: animeId } }, body: to }).catch(() => undefined);
    // The room reloads everyone's player at the room's position.
    if (room) {
      void room.switchStream?.(to);
      return;
    }
    router.replace(tvHref(watchHref(to.source, animeId, episode, to.lang, video.current?.currentTime ?? current)));
  }

  function chooseAudio(id: number) {
    hls.chooseAudio(id);
    const found = hls.audioTracks.find((a) => a.id === id)?.lang;
    if (found) void api.PUT("/watch/preferences", { body: { audio_lang: found } }).catch(() => undefined);
  }

  const shown = active || !playing || ended || panel !== null || seek.target !== null || error !== null;
  // What the remote is driving: a card or panel keeps it, otherwise the control card does.
  // The TV refused to start the room's video on its own: one press of OK joins.
  const blocked = room !== undefined && sync.blocked;
  const mode = error ? "error" : blocked ? "blocked" : ended ? "ended" : panel ? "panel" : "controls";

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

  const subtitleNames = trackNames(tracks, locale);
  const languageRows = language.rows();
  const sections: Record<Panel, MenuSection[]> = {
    language: [...new Set(languageRows.map((row) => row.section))].map((section) => ({
      title: section,
      options: languageRows
        .filter((row) => row.section === section)
        .map((row) => ({
          key: `lang-${row.key}`,
          label: row.label,
          detail: row.detail,
          selected: row.checked,
          disabled: row.disabled,
          onPick: row.onPick,
        })),
    })),
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
        options: (canSwitchStream ? streams : []).map((s) => ({
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
  const panelTitle: Record<Panel, string> = { language: t("language.title"), subtitles: t("subtitles"), audio: t("audio"), source: canSwitchStream ? t("source") : t("settings.quality") };
  const others = canSwitchStream ? streams.filter((s) => !sameStream(s, { source, lang })) : [];
  // This TV's video comes from another source than the room's, so it may not line up exactly.
  const otherSource = room && url && !automatic && !following && !sameStream(playingFrom, { source, lang }) ? streamLabel(names, { source, lang }) : null;
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
        autoPlay={!room}
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
          setBegun(true);
          sync.onReady();
        }}
        onError={() => url && setError("playback_failed")}
        className="absolute inset-0 h-full w-full"
      >
        {tracks.map((track) => (
          <track key={track.url} kind="subtitles" src={`/api/proxy${track.url}`} srcLang={track.lang} label={track.label} />
        ))}
      </video>

      {drawStyled && <AssSubtitles key={drawStyled} video={video} url={`/api/proxy${drawStyled}`} fonts={fonts} onFail={subtitles.onAssFail} lowMemory />}

      <SubtitleOverlay
        video={video}
        draw={!drawStyled}
        selected={selected}
        tracksKey={tracks.map((track) => track.url).join()}
        style={style}
        controlsShown={shown && mode === "controls"}
        controlsHeight={CONTROLS_HEIGHT}
      />

      {!error && waiting && !ended && !blocked && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center" role="status">
          <span className="h-20 w-20 animate-spin rounded-full border-[6px] border-line-strong border-t-accent" />
          <span className="sr-only">{t("loading")}</span>
        </div>
      )}

      {error && (
        <TvPlayerError error={error} onRetry={retry} onExit={exit} others={others} names={names} onSwitch={switchStream} />
      )}

      {blocked && !error && <TvJoinCard onJoin={sync.unblock} />}

      {ended && !error && !blocked && (
        <TvEndCard
          title={title}
          next={next}
          nextTitle={next !== undefined ? (art?.episodes?.[next]?.title ?? null) : null}
          still={next !== undefined ? (thumbnails[next] ? `/api/proxy${thumbnails[next]}` : (art?.episodes?.[next]?.image ?? null)) : null}
          stillFromSource={next !== undefined && !!thumbnails[next]}
          backdrop={art?.backdrop ?? null}
          poster={poster}
          total={NEXT_COUNTDOWN}
          countdown={countdown}
          autoNext={autoNext}
          onPlayNext={goNext}
          onCancelCountdown={() => setCountdown(null)}
          onExit={exit}
        />
      )}

      {skip && !error && !ended && !panel && !blocked && (
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

      {!error && !ended && !blocked && (
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
            {room && <div className="ml-auto shrink-0 self-center pl-6">{room.topBar}</div>}
          </div>
          {otherSource && (
            <p role="status" className="absolute left-[var(--tv-x)] top-[9.5rem] max-w-[60rem] text-[1.375rem] text-soft">
              {t("roomOtherSource", { room: otherSource })}
            </p>
          )}
          <div className={`absolute inset-x-[var(--tv-x)] bottom-20 ${shown ? "pointer-events-auto" : ""}`}>
            <TvSeekBar current={current} duration={duration} target={seek.target} onNudge={seek.nudge} onEnter={togglePlay} />
            <div className="mt-4 flex items-center gap-6">
              <TvControl focusKey={PLAY_KEY} round icon={playing ? "pause" : "play"} label={playing ? t("pause") : t("play")} onPress={togglePlay} />
              <TvControl focusKey="tvp-rewind" round icon="rewind" label={t("rewind")} onPress={() => seek.nudge(-1)} />
              <TvControl focusKey="tvp-forward" round icon="forward" label={t("forward")} onPress={() => seek.nudge(1)} />
              {next !== undefined && <TvControl focusKey="tvp-next" icon="next" label={t("nextShort")} onPress={goNext} />}
              <p className="mx-4 min-w-0 flex-1 truncate text-right text-[1.375rem] text-soft">{sourceLine}</p>
              <div className="flex shrink-0 items-center gap-6">
                {language.offered && <TvControl focusKey="tvp-language" label={t("language.title")} onPress={() => setPanel("language")} />}
                {tracks.length > 0 && <TvControl focusKey="tvp-subtitles" label={t("subtitles")} onPress={() => setPanel("subtitles")} />}
                {audioNames.length > 1 && <TvControl focusKey="tvp-audio" label={t("audio")} onPress={() => setPanel("audio")} />}
                {/* A room's guest can't move the room to another source; what is left is the picture quality. */}
                {(canSwitchStream || hls.qualities.length > 1) && (
                  <TvControl focusKey="tvp-source" label={canSwitchStream ? t("source") : t("settings.quality")} onPress={() => setPanel("source")} />
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {room?.overlay}

      {language.notice && !error && (
        <div
          role="status"
          className="pointer-events-none absolute left-1/2 top-16 flex max-w-[60rem] -translate-x-1/2 items-center gap-4 rounded-full border border-line bg-surface px-8 py-4 text-[1.5rem] text-fg"
        >
          {language.notice.busy && (
            <span aria-hidden="true" className="h-7 w-7 shrink-0 animate-spin rounded-full border-[3px] border-line-strong border-t-accent motion-reduce:animate-none" />
          )}
          <span>{language.notice.text}</span>
        </div>
      )}

      {panel && !error && <TvPlayerMenu title={panelTitle[panel]} sections={sections[panel]} empty={tv("nothingElse")} />}
    </div>
  );
}

function skipKey(kind: string) {
  return kind === "intro" ? "skipIntro" : kind === "recap" ? "skipRecap" : "skipOutro";
}
