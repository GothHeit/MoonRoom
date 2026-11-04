"use client";

import { errorCode } from "@app/api-client";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";

import { useToast } from "@/components/ui/Toast";
import { Link, useRouter } from "@/i18n/navigation";
import { api } from "@/lib/api";
import { AUTO_SOURCE } from "@/lib/pick-stream";
import { warmPlayback } from "@/lib/warm-playback";
import { watchHref, type Lang, type StreamChoice } from "@/lib/watch-target";

import { RoomNotices } from "@/components/room/RoomNotices";
import { useRoomSync, type RoomBinding } from "@/components/room/useRoomSync";

import { useAutoNext } from "./autoNext";
import { ControlBar, iconButton } from "./ControlBar";
import { DroppedPrompt } from "./DroppedPrompt";
import { EndCard } from "./EndCard";
import { ErrorPanel, errorKey } from "./ErrorPanel";
import { PlayerIcon } from "./icons";
import { languageName, trackNames } from "./languages";
import { SettingsMenu } from "./SettingsMenu";
import { sameStream, streamLabel, type StreamNames } from "./streams";
import { activeSkip } from "./skips";
import { AssSubtitles } from "./AssSubtitles";
import { SubtitleOverlay } from "./SubtitleOverlay";
import type { SubtitleStyle } from "./subtitleStyle";
import { useCastLink } from "./useCastLink";
import { useHls } from "./useHls";
import { usePlayback } from "./usePlayback";
import { usePlayerKeys } from "./usePlayerKeys";
import { useDroppedPrompt } from "./useDroppedPrompt";
import { useProgressSaver } from "./useProgressSaver";
import { useSkips } from "./useSkips";
import { useSubtitles } from "./useSubtitles";
import { useVideoControls } from "./useVideoControls";

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
  /** Whether the skip intro, recap and credits buttons are offered. */
  showSkips: boolean;
  /** Set when watching together: the room drives playback and picks the next episode. */
  room?: RoomBinding;
};

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const HIDE_CONTROLS_MS = 3000;
export const NEXT_COUNTDOWN = 10;
// How long before the end the next episode is resolved, so auto-next starts at once.
const WARM_NEXT_SECONDS = 180;

export function Player(props: Props) {
  const { source, animeId, episode, title, episodes, lang, startAt, subtitleLang, room, showSkips } = props;
  const t = useTranslations("player");
  const locale = useLocale();
  const router = useRouter();
  const toast = useToast();
  // Full screen goes to the watch layout's stage around this, which outlives the episode,
  // so it survives auto-next.
  const stage = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const started = useRef(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const playback = usePlayback(source, animeId, episode, lang);
  const { attempt, url, kind, tracks, fonts, answered, answeredLang, ownSkips, defaultAudio, maxHeight, error, setError } = playback;
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Every source and sub/dub that has this episode, for the source menu.
  const [streams, setStreams] = useState<StreamChoice[]>([]);
  // The menu is only asked for once the stream has loaded (or failed, or the menu is opened),
  // so it never competes with starting the stream.
  const [askStreams, setAskStreams] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [waiting, setWaiting] = useState(true);
  const [current, setCurrent] = useState(startAt);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [rate, setRate] = useState(1);
  const [active, setActive] = useState(true);
  const [ended, setEnded] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const autoNext = useAutoNext();

  const playbackRetry = playback.retry;
  const retry = useCallback(() => {
    started.current = false;
    playbackRetry();
  }, [playbackRetry]);
  const failPlayback = useCallback(() => setError("playback_failed"), [setError]);
  const subtitles = useSubtitles(tracks, subtitleLang, props.subtitleStyle);
  const { selected, styled, style } = subtitles;
  // A link a receiver can fetch on its own, kept ready only where AirPlay exists.
  const castUrl = useCastLink(url !== null, answered, animeId, episode, answeredLang, kind, selected);
  const hls = useHls({ video, url, kind, defaultAudio, maxHeight, castUrl, onRetry: retry, onFail: failPlayback });
  const controls = useVideoControls(video, stage, !!url);
  const { fullscreen, togglePlay, toggleFullscreen, toggleMute, seekBy, changeVolume } = controls;

  const subtitleNames = trackNames(tracks, locale);
  const names: StreamNames = { has: (key) => t.has(key), t: (key, values) => t(key, values) };
  // What is playing, and what the viewer picked: they differ when the API chooses (automatic) or
  // when the picked source failed and another answered.
  const playingFrom: StreamChoice = { source: answered, lang: answeredLang };
  const automatic = source === AUTO_SOURCE;
  const picked: StreamChoice = automatic ? { source, lang } : playingFrom;
  const playingName = streamLabel(names, playingFrom);
  // In a room only the host moves everyone to another stream.
  const canSwitchStream = !room || room.switchStream !== undefined;
  const audioNames = hls.audioTracks.map((a) => ({ ...a, label: languageName(a.lang, locale) ?? a.label }));

  // The audio the viewer picks is the one they will want next time: the automatic choice and
  // every stream that carries it start there.
  const chooseAudio = (id: number) => {
    hls.chooseAudio(id);
    const lang = hls.audioTracks.find((a) => a.id === id)?.lang;
    if (lang) void api.PUT("/watch/preferences", { body: { audio_lang: lang } }).catch(() => undefined);
  };

  const next = episodes.find((e) => e > episode);
  // Near the end, have the API resolve the next episode so pressing next (or auto-next) is quick.
  const nearEnd = next !== undefined && duration > 0 && current > Math.max(duration - WARM_NEXT_SECONDS, duration / 2);
  useEffect(() => {
    if (nearEnd && next !== undefined) warmPlayback(source, animeId, next, lang);
  }, [nearEnd, source, animeId, next, lang]);
  const backHref = `/anime/${animeId}`;
  const dropped = useDroppedPrompt(animeId);
  const { save, onTime } = useProgressSaver(video, animeId, episode, dropped.check);
  const sync = useRoomSync(
    {
      read: () => {
        const v = video.current;
        if (!v || v.readyState < 1) return null;
        const wireless = (v as HTMLVideoElement & { webkitCurrentPlaybackTargetIsWireless?: boolean })
          .webkitCurrentPlaybackTargetIsWireless;
        return { currentTime: v.currentTime, paused: v.paused, playbackRate: v.playbackRate, seeking: v.seeking, wireless: wireless === true };
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

  const wantStreams = askStreams || settingsOpen || error !== null;
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
      // Without the list the menu just has nothing to switch to.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [animeId, episode, wantStreams]);

  // Whole seconds, so the small corrections players make to the length don't ask again.
  const length = url && Number.isFinite(duration) && duration > 0 ? Math.round(duration) : 0;
  // Someone who turned the buttons off never asks AniSkip either.
  const skips = useSkips(ownSkips, animeId, episode, showSkips ? length : 0);
  const skip = showSkips ? activeSkip(skips, current) : undefined;
  const skipNow = useCallback(() => {
    const v = video.current;
    const target = showSkips ? activeSkip(skips, v?.currentTime ?? 0) : undefined;
    if (v && target) v.currentTime = target.end;
  }, [skips, showSkips]);

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

  const closeSettings = useCallback(() => setSettingsOpen(false), []);
  usePlayerKeys(
    { togglePlay, seekBy, changeVolume, toggleFullscreen, toggleMute, goNext, skipNow, closeSettings, poke },
    settingsOpen,
  );

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
      // A room plays the same stream for everyone, so it starts from what is playing now.
      .POST("/watch/rooms", { body: { source: answered, anime_id: animeId, title, episode, lang: answeredLang } })
      .catch(() => ({ data: undefined, error: { error: { code: "network" } } }));
    if (data) router.push(`/room/${data.code}`);
    else toast(t(errorKey(errorCode(body))), "error");
  }

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

  const others = canSwitchStream ? streams.filter((s) => !sameStream(s, { source, lang })) : [];
  const streamName = automatic ? t("autoPlaying", { stream: playingName }) : playingName;
  const shown = active || !playing || ended || settingsOpen || error !== null;

  return (
    <div
      ref={stage}
      role="region"
      aria-label={t("region")}
      onMouseMove={poke}
      onTouchStart={poke}
      className={`fixed z-[60] bg-black text-fg ${room?.frame ?? "inset-0"} ${shown ? "" : "cursor-none"}`}
    >
      <video
        ref={video}
        src={kind === "mp4" ? (url ?? undefined) : undefined}
        autoPlay={!room}
        playsInline
        x-webkit-airplay="allow"
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
        // In a room the speed is the room's to nudge, never the viewer's to pick.
        onRateChange={() => !room && video.current && setRate(video.current.playbackRate)}
        onError={() => url && setError("playback_failed")}
        className="absolute inset-0 h-full w-full"
      >
        {tracks.map((track) => (
          <track key={track.url} kind="subtitles" src={`/api/proxy${track.url}`} srcLang={track.lang} label={track.label} />
        ))}
      </video>

      {styled && <AssSubtitles key={styled} video={video} url={`/api/proxy${styled}`} fonts={fonts} onFail={subtitles.onAssFail} />}

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
        <ErrorPanel error={error} backHref={backHref} onRetry={retry} others={others} names={names} onSwitch={switchStream} />
      )}

      <div
        className={`pointer-events-none absolute inset-0 flex flex-col justify-between pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] pt-[env(safe-area-inset-top)] transition-opacity duration-300 ${shown ? "opacity-100" : "opacity-0"}`}
      >
        <div className="pointer-events-auto flex items-center gap-3 bg-gradient-to-b from-black/80 to-transparent px-4 pb-10 pt-4 sm:px-8">
          <Link href={backHref} aria-label={t("back")} className={iconButton}>
            <PlayerIcon name="back" />
          </Link>
          <div className="min-w-0">
            <p className="truncate font-display text-xl leading-tight">{title}</p>
            <p className="text-sm text-muted">
              {t("episode", { episode })}
              {!automatic && answered !== source && (
                <span className="ml-2">· {t("fallbackSource", { source: playingName })}</span>
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
          <ControlBar
            current={current}
            duration={duration}
            playing={playing}
            muted={muted}
            volume={volume}
            fullscreen={fullscreen}
            settingsOpen={settingsOpen}
            hasNext={next !== undefined}
            airPlay={hls.airPlay}
            onSeekTo={(seconds) => {
              if (video.current) video.current.currentTime = seconds;
              setCurrent(seconds);
            }}
            onTogglePlay={togglePlay}
            onSeekBy={seekBy}
            onToggleMute={toggleMute}
            onVolume={(level) => {
              const v = video.current;
              if (!v) return;
              v.volume = level;
              v.muted = v.volume === 0;
            }}
            onToggleSettings={() => setSettingsOpen((o) => !o)}
            onNext={goNext}
            onToggleFullscreen={toggleFullscreen}
          />
        )}
      </div>

      {room?.overlay}
      {room && (
        <RoomNotices
          blocked={sync.blocked}
          onUnblock={sync.unblock}
          controlsShown={shown}
          otherSource={
            url && !automatic && answered !== source
              ? {
                  room: streamLabel(names, { source, lang }),
                  onMove: room.switchStream ? () => void room.switchStream?.(playingFrom) : undefined,
                }
              : undefined
          }
          debug={room.debug && { stats: sync.stats, ...room.debug }}
        />
      )}

      {settingsOpen && !error && (
        <>
          <button
            type="button"
            tabIndex={-1}
            aria-hidden="true"
            onClick={closeSettings}
            className="absolute inset-0 cursor-default"
          />
          <SettingsMenu
            qualities={hls.qualities}
            quality={hls.quality}
            onQuality={hls.chooseQuality}
            audioTracks={audioNames}
            audioTrack={hls.audioTrack}
            onAudioTrack={chooseAudio}
            streams={canSwitchStream ? streams.map((s) => streamLabel(names, s)) : []}
            stream={streams.findIndex((s) => sameStream(s, picked))}
            onStream={(index) => switchStream(streams[index])}
            streamName={streamName}
            subtitleNames={subtitleNames}
            subtitle={selected}
            onSubtitle={subtitles.chooseTrack}
            speeds={room ? [] : SPEEDS}
            rate={rate}
            onRate={(r) => {
              if (video.current) video.current.playbackRate = r;
            }}
            style={style}
            onStyle={subtitles.changeStyle}
            onClose={closeSettings}
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

      {dropped.asking && !error && <DroppedPrompt onAccept={dropped.accept} onDismiss={dropped.dismiss} />}

      {ended && !error && (
        <EndCard
          next={next}
          countdown={countdown}
          autoNext={autoNext}
          backHref={backHref}
          onPlayNext={goNext}
          onCancelCountdown={() => setCountdown(null)}
        />
      )}
    </div>
  );
}
