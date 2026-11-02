// Title, progress and streaming endpoints for the fake API, with a stubbed video source.
import { readFileSync } from "node:fs";

const CLIP = readFileSync(new URL("./fixtures/clip.webm", import.meta.url));
const SOURCE = "stub";
const EPISODES = { sub: [1, 2, 3], dub: [1] };
// Episode 1 comes with subtitle tracks; the others have none.
const SUBTITLE_EPISODE = 1;
const VTT = "WEBVTT\n\n00:00:00.000 --> 00:00:30.000\n<i>Hello</i> moon\n";
// A title whose subtitles also come styled, like the local library's: a magenta box over the
// whole picture, easy to spot in a screenshot.
const STYLED_ANIME = 7;
const ASS = `[Script Info]
ScriptType: v4.00+
PlayResX: 640
PlayResY: 360

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,20,&H00FF00FF,&H00FF00FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:10:00.00,Default,,0,0,0,,{\\pos(0,0)\\p1}m 0 0 l 640 0 640 360 0 360{\\p0}
`;
// Episode 3 has an intro to skip.
const SKIPS = { 3: [{ kind: "intro", start: 2, end: 25 }] };
// Asking this source plays from the stub one, like a fallback after a failure.
const FLAKY = "flaky";
const DEFAULT_PREFERENCES = {
  subtitle_size: "medium",
  subtitle_color: "white",
  subtitle_background: "outline",
  subtitle_position: "bottom",
};
let preferences = { ...DEFAULT_PREFERENCES };
// anime id -> the source and sub/dub picked in the player.
const choices = new Map();

export const choiceFor = (animeId) => choices.get(animeId) ?? null;

// What the real API returns with the sources: the stream it picked and that stream's episodes.
export function streamFor(animeId) {
  const stream = choiceFor(animeId) ?? { source: SOURCE, lang: "sub" };
  const episodes = EPISODES[stream.lang] ?? EPISODES.sub;
  return { stream, listing: { source: SOURCE, source_title: "Moon Test", episodes, thumbnails: {} } };
}

function details(id) {
  const watchable = id !== 2;
  return {
    id,
    title: watchable ? `Moon Test ${id}` : "Tracking Only Test",
    alternative_titles: { en: "The Moon Test", ja: null, synonyms: [] },
    main_picture: null,
    synopsis: "A test title about the moon.",
    mean: 8.51,
    genres: [{ id: 1, name: "Action" }],
    studios: [{ id: 1, name: "Test Studio" }],
    start_season: { year: 2026, season: "fall" },
    media_type: "tv",
    status: "currently_airing",
    num_episodes: 3,
    pictures: [],
    related_anime: [
      { relation_type: "sequel", relation_type_formatted: "Sequel", anime: { id: 10, title: "Moon Test Sequel" } },
    ],
    recommendations: [{ num_recommendations: 4, anime: { id: 11, title: "Sun Test" } }],
  };
}

// anime id -> episode -> progress. Anime 1 is read by the title page tests, anime 4 is
// written by the player tests.
const progress = new Map();
function seed(animeId, episode, position, completed) {
  if (!progress.has(animeId)) progress.set(animeId, new Map());
  progress.get(animeId).set(episode, {
    anime_id: animeId,
    episode,
    position_seconds: position,
    duration_seconds: 40,
    completed,
    updated_at: new Date(Date.now() + episode).toISOString(),
  });
}
seed(1, 1, 40, true);
seed(1, 2, 12, false);
seed(4, 2, 12, false);
// Anime 6 is fully watched, so its title page offers a rewatch.
for (const episode of [1, 2, 3]) seed(6, episode, 40, true);

// anime id -> MAL list status. Anime 4 starts as completed.
const listStatus = new Map([[4, "completed"]]);

function serveClip(req, res) {
  const match = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? "");
  if (!match) {
    res.writeHead(200, { "Content-Type": "video/webm", "Content-Length": CLIP.length, "Accept-Ranges": "bytes" });
    return res.end(CLIP);
  }
  const start = Number(match[1]);
  const end = match[2] ? Math.min(Number(match[2]), CLIP.length - 1) : CLIP.length - 1;
  if (start >= CLIP.length) {
    res.writeHead(416, { "Content-Range": `bytes */${CLIP.length}` });
    return res.end();
  }
  res.writeHead(206, {
    "Content-Type": "video/webm",
    "Content-Length": end - start + 1,
    "Content-Range": `bytes ${start}-${end}/${CLIP.length}`,
    "Accept-Ranges": "bytes",
  });
  res.end(CLIP.subarray(start, end + 1));
}

/** Handles the request and returns true, or returns false when the path isn't one of these. */
export async function handleWatch(req, res, { url, send, error, body, authed }) {
  const path = url.pathname;
  const reply = (status, json) => {
    send(status, json);
    return true;
  };

  if (path === "/__progress") {
    const all = [...progress.values()].flatMap((m) => [...m.values()]);
    return reply(200, all);
  }
  if (path === "/watch/subtitles") {
    res.writeHead(200, { "Content-Type": "text/vtt" });
    res.end(VTT);
    return true;
  }
  if (path === "/watch/subtitles.ass") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(ASS);
    return true;
  }
  if (path === "/watch/video") {
    // The playback token stands in for the session, like the real API.
    if (!url.searchParams.get("token")?.startsWith("ep-")) return reply(401, error("invalid_token"));
    serveClip(req, res);
    return true;
  }

  if (path === "/watch/preferences") {
    if (!authed) return reply(401, error("not_authenticated"));
    if (req.method === "PUT") preferences = { ...DEFAULT_PREFERENCES, ...(await body(req)) };
    return reply(200, preferences);
  }

  if (/^\/watch\/[^/]+\/\d+\/episodes\/\d+\/prepare$/.test(path)) {
    if (!authed) return reply(401, error("not_authenticated"));
    res.writeHead(202);
    res.end();
    return true;
  }

  let m = /^\/watch\/options\/(\d+)\/(\d+)$/.exec(path);
  if (m) {
    if (!authed) return reply(401, error("not_authenticated"));
    const episode = Number(m[2]);
    return reply(
      200,
      ["sub", "dub"].filter((lang) => EPISODES[lang].includes(episode)).map((lang) => ({ source: SOURCE, lang })),
    );
  }
  m = /^\/watch\/choice\/(\d+)$/.exec(path);
  if (m && req.method === "PUT") {
    if (!authed) return reply(401, error("not_authenticated"));
    choices.set(Number(m[1]), await body(req));
    res.writeHead(204);
    res.end();
    return true;
  }
  m = /^\/anime\/(\d+)$/.exec(path);
  if (m) {
    if (!authed) return reply(401, error("not_authenticated"));
    return reply(200, details(Number(m[1])));
  }
  m = /^\/me\/progress\/(\d+)(?:\/(\d+))?$/.exec(path);
  if (m) {
    if (!authed) return reply(401, error("not_authenticated"));
    const animeId = Number(m[1]);
    if (req.method === "PUT") {
      const { position_seconds, duration_seconds, completed } = await body(req);
      const episode = Number(m[2]);
      const was = progress.get(animeId)?.get(episode)?.completed ?? false;
      seed(animeId, episode, position_seconds, was || completed || position_seconds >= 0.9 * duration_seconds);
      return reply(200, progress.get(animeId).get(episode));
    }
    return reply(200, [...(progress.get(animeId)?.values() ?? [])]);
  }
  m = /^\/me\/animelist\/(\d+)$/.exec(path);
  if (m) {
    if (!authed) return reply(401, error("not_authenticated"));
    const animeId = Number(m[1]);
    if (req.method === "PATCH") {
      listStatus.set(animeId, (await body(req)).status);
      return reply(200, { status: listStatus.get(animeId) });
    }
    return reply(200, { linked: true, status: listStatus.get(animeId) ?? null, score: 0, num_episodes_watched: 0 });
  }
  m = /^\/watch\/([^/]+)\/(\d+)\/episodes(?:\/(\d+)\/play)?$/.exec(path);
  if (m) {
    if (!authed) return reply(401, error("not_authenticated"));
    if (m[1] !== SOURCE && !(m[1] === FLAKY && m[3])) return reply(404, error("source_not_found"));
    const lang = url.searchParams.get("lang") === "dub" ? "dub" : "sub";
    if (!m[3]) return reply(200, { source: SOURCE, source_title: "Moon Test", episodes: EPISODES[lang], thumbnails: {} });
    const episode = Number(m[3]);
    if (!EPISODES[lang].includes(episode)) return reply(404, error("not_available"));
    const animeId = Number(m[2]);
    const subtitles =
      animeId === STYLED_ANIME
        ? [{ lang: "pt-BR", label: "EmmidSubs", url: "/watch/subtitles?l=pt-BR", ass_url: "/watch/subtitles.ass" }]
        : episode === SUBTITLE_EPISODE
        ? [
            { lang: "en", label: "English", url: "/watch/subtitles?l=en" },
            { lang: "pt-BR", label: "Portuguese", url: "/watch/subtitles?l=pt-BR" },
          ]
        : [];
    return reply(200, {
      source: SOURCE,
      skips: SKIPS[episode] ?? [],
      default_audio: null,
      kind: "mp4",
      resolution: 720,
      url: `/watch/video?token=ep-${episode}-${lang}`,
      subtitles,
    });
  }
  return false;
}
