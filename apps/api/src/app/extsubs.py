"""Brazilian Portuguese subtitles from OpenSubtitles, for sharp copies that only carry others.

The sharpest copies of many episodes (ZokoAnime, KickAssAnime, AniZone) come with English
subtitles only, while the Portuguese ones sit on other sites with the text burned into a softer
picture. OpenSubtitles keeps fan-made pt-BR files for many episodes. Their timing matches the
broadcast or disc they were made for, which usually starts a few seconds apart from the copy we
play, and may differ by a cut scene or recap in the middle.

So a file is only offered once it has been fitted to the copy it is shown on: its cue start
times are compared with those of the copy's own subtitle track (English, usually), which speaks
the same lines at the same moments. The shift where most starts meet wins; when the second part
of the episode fits a different shift (a cut), the file is fitted in two pieces. A file that
doesn't fit well is never offered: it is most likely for another season, cut or show.

Machine-translated files are never used (kafka turned them down), whatever the fit.

What is found is kept in the shared cache: the fitted track for two weeks (per source, since
each source's copy can start at a different time), a miss for a day.
"""

import asyncio
import logging
import re
import zlib
from bisect import bisect_left, bisect_right
from collections import Counter
from dataclasses import dataclass, replace
from statistics import median
from urllib.parse import quote, urlsplit

import httpx
from cachetools import TTLCache

from app.errors import ApiError
from app.ranking import base_lang
from app.sharedcache import SharedCache
from app.singleflight import SingleFlight
from app.sources.base import EpisodeList, Lang, Stream, Subtitle, VideoSource
from app.sources.matching import SEASON, mal_titles, normalize, search_queries
from app.subtitles import OVERRIDES
from app.upstream import host_headers, open_upstream, read_capped

log = logging.getLogger(__name__)

# The subtitle "link" a fitted track is served under: the proxy reads it from the cache, it is
# never fetched. Signed like any other link, so a viewer can't ask for another key.
SCHEME = "extsub:"
LABEL = "Português (Brasil) · OpenSubtitles"
LANG = "pt-BR"

API = "https://rest.opensubtitles.org"
SEARCH_TIMEOUT = 10.0
DOWNLOAD_TIMEOUT = 15.0
# A compressed subtitle file is tens of kilobytes; anything far larger isn't one.
MAX_DOWNLOAD = 1024 * 1024
MAX_TEXT = 4 * 1024 * 1024
# Files tried per episode, best first.
MAX_CANDIDATES = 3
FORMATS = {"srt", "vtt", "ass", "ssa"}

# How long the first look for an episode may hold up a play. It goes on in the background
# after that, and the next play (or the next episode warmed ahead) has it.
FIRST_WAIT = 4.0
SEARCH_TTL = 24 * 3600
FOUND_TTL = 14 * 24 * 3600
MISS_TTL = 24 * 3600
# OpenSubtitles or the video host failed: look again soon.
ERROR_TTL = 600
# Versioned: a change to what is stored gets a new name, so old entries are never misread.
SEARCH_NS = "opensubtitles-search-v1"
TRACK_NS = "pt-subtitle-fit-v1"

# Two starts this close count as the same line.
MATCH = 0.2
# The largest shift looked for, either way.
MAX_SHIFT = 600.0
BIN = 0.1
# A fit is offered when this share of the lines meets the copy's track, and at least this many.
MIN_RATIO = 0.4
MIN_MATCHED = 15
# A fit in two pieces is used when it places this many more of the lines.
SPLIT_GAIN = 0.05

# Words that say a file was made by a translation engine. "IA"/"AI" only in capitals: "ia" is
# a common Portuguese word.
MACHINE = re.compile(
    r"google|deepl|machine|autom[aá]tic|auto[- ]?transl|chat ?gpt|\bgpt\b|\bllm\b",
    re.IGNORECASE,
)
MACHINE_ACRONYM = re.compile(r"\b(?:IA|AI|I\.A\.)(?:\b|$)")
# Lines OpenSubtitles or the uploader slip in that aren't the show's.
ADVERT = re.compile(
    r"opensubtitles|osdb\.link|www\.|https?://|\.com\b|\.org\b|\.net\b|vip member|advertise",
    re.IGNORECASE,
)
# Styles of ASS lines that aren't dialogue: song lyrics, karaoke, on-screen signs, credits.
NOT_SPOKEN_STYLE = re.compile(
    r"^(?:op|ed)(?:$|[^a-z]|jp|rom|tl|br|pt|kan|eng)|sign|song|kara|lyric|opening|ending|insert"
    r"|typeset|logo|credit|title|note|\bts\b",
    re.IGNORECASE,
)
# ASS lines placed by hand or sung: signs and karaoke, not dialogue.
NOT_SPOKEN_TAG = re.compile(r"\\(?:pos|move|org|clip|k[fo]?\d|K\d|p[1-9])", re.IGNORECASE)
TIME = re.compile(r"(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})")
ALLOWED_TAG = r"/?[ibu]>"


@dataclass(frozen=True)
class Cue:
    start: float
    end: float
    text: str = ""


@dataclass(frozen=True)
class Fit:
    # Seconds added to every cue, and the cue time after which `late_shift` applies instead.
    shift: float
    matched: int
    ratio: float
    split: float | None = None
    late_shift: float | None = None

    def place(self, t: float) -> float:
        if self.split is not None and self.late_shift is not None and t >= self.split:
            return t + self.late_shift
        return t + self.shift


# --- Reading subtitle files --------------------------------------------------------------


def _seconds(found: re.Match) -> float:
    hours, minutes, seconds, fraction = found.groups()
    whole = int(hours or 0) * 3600 + int(minutes) * 60 + int(seconds)
    return whole + int(fraction.ljust(3, "0")) / 1000


def parse_timed(text: str) -> list[Cue]:
    """The cues of an SRT or WebVTT file: a line with "-->" and the text lines under it."""
    cues: list[Cue] = []
    lines = text.lstrip("\ufeff").replace("\r\n", "\n").replace("\r", "\n").split("\n")
    i = 0
    while i < len(lines):
        line = lines[i]
        i += 1
        if "-->" not in line:
            continue
        left, _, right = line.partition("-->")
        start, end = TIME.search(left), TIME.search(right)
        if not start or not end:
            continue
        body: list[str] = []
        while i < len(lines) and lines[i].strip() and "-->" not in lines[i]:
            body.append(lines[i].strip())
            i += 1
        cues.append(Cue(_seconds(start), _seconds(end), _clean_markup("\n".join(body))))
    return cues


def _clean_markup(body: str) -> str:
    body = OVERRIDES.sub("", body)  # {\an8} and the like, which some SRT files carry
    return re.sub(rf"<(?!{ALLOWED_TAG})[^>]*>", "", body).strip()


def _ass_time(value: str) -> float | None:
    try:
        hours, minutes, seconds = value.strip().split(":")
        return int(hours) * 3600 + int(minutes) * 60 + float(seconds)
    except ValueError:
        return None


def parse_ass(text: str) -> list[Cue]:
    """The spoken lines of an ASS script: song, sign and karaoke lines are left out, since the
    copy's own track rarely has them at the same times and they would crowd the screen."""
    fields: list[str] = []
    rows: list[tuple[str, Cue, str]] = []
    in_events = False
    for raw in text.lstrip("\ufeff").splitlines():
        line = raw.strip()
        if line.startswith("["):
            in_events = line.lower() == "[events]"
        elif in_events and line.lower().startswith("format:"):
            fields = [f.strip().lower() for f in line.split(":", 1)[1].split(",")]
        elif in_events and fields and line.lower().startswith("dialogue:"):
            parts = line.split(":", 1)[1].lstrip().split(",", len(fields) - 1)
            row = dict(zip(fields, parts, strict=False))
            start, end = _ass_time(row.get("start", "")), _ass_time(row.get("end", ""))
            body = row.get("text", "")
            if start is None or end is None or NOT_SPOKEN_TAG.search(body):
                continue
            body = body.replace("{\\i1}", "<i>").replace("{\\i0}", "</i>")
            body = OVERRIDES.sub("", body).replace("\\N", "\n").replace("\\n", "\n")
            body = body.replace("\\h", " ").strip()
            if body:
                rows.append((row.get("style", "").strip(), Cue(start, end, body), body))
    spoken = [cue for style, cue, _ in rows if not NOT_SPOKEN_STYLE.search(style)]
    if not spoken and rows:
        # Every style looked like a sign: keep the most used one, which is the dialogue.
        common = Counter(style for style, _, _ in rows).most_common(1)[0][0]
        spoken = [cue for style, cue, _ in rows if style == common]
    return sorted(spoken, key=lambda c: c.start)


def parse_any(text: str) -> list[Cue]:
    return parse_ass(text) if "[events]" in text.lower() else parse_timed(text)


def without_adverts(cues: list[Cue]) -> list[Cue]:
    return [c for c in cues if c.text and not ADVERT.search(c.text)]


def _timestamp(t: float) -> str:
    ms = round(max(t, 0.0) * 1000)
    hours, ms = divmod(ms, 3_600_000)
    minutes, ms = divmod(ms, 60_000)
    seconds, ms = divmod(ms, 1000)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}.{ms:03d}"


def _escape(text: str) -> str:
    text = text.replace("&", "&amp;")
    return re.sub(rf"<(?!{ALLOWED_TAG})", "&lt;", text)


def to_vtt(cues: list[Cue]) -> str:
    lines = ["WEBVTT", ""]
    for cue in cues:
        lines += [f"{_timestamp(cue.start)} --> {_timestamp(cue.end)}", _escape(cue.text), ""]
    return "\n".join(lines)


# --- Fitting a file to the copy ----------------------------------------------------------


def _best_shift(starts: list[float], reference: list[float]) -> float | None:
    """The shift that makes the most of `starts` meet a start in `reference`."""
    votes: Counter[int] = Counter()
    for t in starts:
        lo = bisect_left(reference, t - MAX_SHIFT)
        hi = bisect_right(reference, t + MAX_SHIFT)
        for r in reference[lo:hi]:
            votes[round((r - t) / BIN)] += 1
    if not votes:
        return None
    best = max(votes, key=lambda b: (votes[b - 1] + votes[b] + votes[b + 1], votes[b]))
    near = [
        r - t
        for t in starts
        for r in reference[
            bisect_left(reference, t + best * BIN - 0.25) : bisect_right(
                reference, t + best * BIN + 0.25
            )
        ]
    ]
    return median(near) if near else best * BIN


def _hits(starts: list[float], reference: list[float], shift: float) -> list[bool]:
    hits = []
    for t in starts:
        moved = t + shift
        i = bisect_left(reference, moved)
        near = [reference[j] for j in (i - 1, i) if 0 <= j < len(reference)]
        hits.append(any(abs(r - moved) <= MATCH for r in near))
    return hits


def fit(cues: list[Cue], reference: list[Cue]) -> Fit | None:
    """How to move `cues` onto the copy whose own track is `reference`, or None when they don't
    fit it well enough to be the same episode and cut."""
    starts = sorted(c.start for c in cues)
    ref = sorted(c.start for c in reference)
    if len(starts) < MIN_MATCHED or len(ref) < MIN_MATCHED:
        return None
    whole = _best_shift(starts, ref)
    if whole is None:
        return None
    base = len(starts) if len(starts) < len(ref) else len(ref)
    hits = _hits(starts, ref, whole)
    best = Fit(whole, sum(hits), sum(hits) / base)

    half = len(starts) // 2
    early, late = _best_shift(starts[:half], ref), _best_shift(starts[half:], ref)
    if early is not None and late is not None and abs(early - late) > 0.5:
        # A cut: find where the second shift takes over, the point placing the most lines.
        first, second = _hits(starts, ref, early), _hits(starts, ref, late)
        score = sum(second)
        top, at = score, 0
        for i in range(len(starts)):
            score += first[i] - second[i]
            if score > top:
                top, at = score, i + 1
        if 0 < at < len(starts) and top - best.matched >= SPLIT_GAIN * len(starts):
            best = Fit(early, top, top / base, starts[at], late)
    if best.matched < MIN_MATCHED or best.ratio < MIN_RATIO:
        return None
    return best


def apply(cues: list[Cue], placed: Fit) -> list[Cue]:
    moved = [
        replace(c, start=placed.place(c.start), end=placed.place(c.start) + (c.end - c.start))
        for c in cues
    ]
    return sorted((c for c in moved if c.end > 0), key=lambda c: c.start)


# --- OpenSubtitles ----------------------------------------------------------------------


def _words(text: str) -> set[str]:
    return {w for w in re.findall(r"[a-z0-9]+", normalize(text)) if len(w) >= 4}


def _season(anime: dict) -> int:
    found = SEASON.search(anime.get("title") or "")
    number = next((n for n in found.groups() if n), None) if found else None
    return int(number) if number else 1


def usable(row: dict, anime: dict, episode: int) -> bool:
    """A pt-BR file for this episode in a format we read, not made by a machine, for a show
    whose name shares a word with the title's."""
    if row.get("SubLanguageID") != "pob" or str(row.get("SeriesEpisode")) != str(episode):
        return False
    if str(row.get("SubAutoTranslation")) == "1" or str(row.get("SubForeignPartsOnly")) == "1":
        return False
    credits = f"{row.get('SubTranslator', '')} {row.get('SubAuthorComment', '')}"
    if MACHINE.search(credits) or MACHINE_ACRONYM.search(credits):
        return False
    if str(row.get("SubSumCD", "1")) != "1" or row.get("SubFormat", "").lower() not in FORMATS:
        return False
    link = urlsplit(row.get("SubDownloadLink") or "")
    if link.scheme != "https" or not (link.hostname or "").endswith(".opensubtitles.org"):
        return False
    show = (row.get("MovieName") or "").split('"')
    series = show[1] if len(show) > 2 else row.get("MovieName") or ""
    ours = set().union(*(_words(t) for t in mal_titles(anime))) if mal_titles(anime) else set()
    return bool(_words(series) & ours)


def _slim(row: dict) -> dict:
    return {
        "id": str(row["IDSubtitleFile"]),
        "link": row["SubDownloadLink"],
        "encoding": row.get("SubEncoding") or "",
        "season": str(row.get("SeriesSeason") or ""),
        "trusted": str(row.get("SubFromTrusted")) == "1",
        "downloads": int(row.get("SubDownloadsCnt") or 0),
        "hearing": str(row.get("SubHearingImpaired")) == "1",
    }


def _decode(data: bytes, encoding: str) -> str:
    for name in (encoding, "utf-8", "cp1252"):
        if not name:
            continue
        try:
            return data.decode(name).lstrip("\ufeff")
        except (LookupError, UnicodeDecodeError):
            continue
    return data.decode("latin-1")


class OpenSubtitles:
    """The old public interface (rest.opensubtitles.org): searching and downloading need no
    account, only a user agent it knows."""

    def __init__(self, http: httpx.AsyncClient, cache: SharedCache, user_agent: str) -> None:
        self._http = http
        self._cache = cache
        self._headers = {"User-Agent": user_agent, "X-User-Agent": user_agent}
        self._searches: SingleFlight[tuple[int, int], list[dict]] = SingleFlight()
        self._downloads: SingleFlight[str, str | None] = SingleFlight()
        self._files: TTLCache[str, str | None] = TTLCache(maxsize=64, ttl=3600)

    async def search(self, anime: dict, episode: int) -> list[dict]:
        """The best few pt-BR files for the episode, best first. Raises when the site fails."""
        key = (int(anime["id"]), episode)
        stored = await self._cache.get(SEARCH_NS, list(key))
        if stored is not None:
            return stored["files"]
        return await self._searches.run(key, lambda: self._search(anime, episode))

    async def _search(self, anime: dict, episode: int) -> list[dict]:
        found: dict[str, dict] = {}
        for query in search_queries(anime):
            term = quote(normalize(query), safe="")
            url = f"{API}/search/episode-{episode}/query-{term}/sublanguageid-pob"
            answer = await self._http.get(url, headers=self._headers, timeout=SEARCH_TIMEOUT)
            answer.raise_for_status()
            rows = answer.json()
            for row in rows if isinstance(rows, list) else []:
                if isinstance(row, dict) and usable(row, anime, episode):
                    found.setdefault(str(row["IDSubtitleFile"]), _slim(row))
            if found:
                break
        season = str(_season(anime))
        files = sorted(
            found.values(),
            key=lambda f: (f["season"] != season, not f["trusted"], f["hearing"], -f["downloads"]),
        )[:MAX_CANDIDATES]
        ttl = SEARCH_TTL if files else MISS_TTL
        await self._cache.set(SEARCH_NS, [int(anime["id"]), episode], {"files": files}, ttl)
        return files

    async def text(self, file: dict) -> str | None:
        """A file's text, or None when it can't be read. Raises when the site fails."""
        if file["id"] in self._files:
            return self._files[file["id"]]
        return await self._downloads.run(file["id"], lambda: self._download(file))

    async def _download(self, file: dict) -> str | None:
        answer = await self._http.get(file["link"], headers=self._headers, timeout=DOWNLOAD_TIMEOUT)
        answer.raise_for_status()
        data = answer.content
        text: str | None = None
        if len(data) <= MAX_DOWNLOAD:
            try:
                if data[:2] == b"\x1f\x8b":
                    inflate = zlib.decompressobj(16 + zlib.MAX_WBITS)
                    data = inflate.decompress(data, MAX_TEXT)
                    if inflate.unconsumed_tail:
                        data = b""  # larger than any subtitle file
                text = _decode(data, file["encoding"]) if data else None
            except zlib.error:
                text = None
        self._files[file["id"]] = text
        return text


# --- Offering the fitted track ------------------------------------------------------------


def reference(subtitles: tuple[Subtitle, ...]) -> Subtitle | None:
    """The copy's own track to fit against: English dialogue if it has it, else any."""
    spoken = [
        s for s in subtitles if not re.search(r"sign|song|forced", s.label, re.IGNORECASE)
    ] or list(subtitles)
    english = [s for s in spoken if base_lang(s.lang) == "en"]
    found = english or spoken
    return found[0] if found else None


class PortugueseSubtitles:
    def __init__(self, http: httpx.AsyncClient, cache: SharedCache, site: OpenSubtitles) -> None:
        self._http = http
        self._cache = cache
        self._site = site
        self._fits: SingleFlight[tuple[int, int, str], dict] = SingleFlight()

    async def for_stream(
        self, anime: dict, episode: int, source: str, stream: Stream
    ) -> Subtitle | None:
        """A fitted pt-BR track for this copy, when the copy has none of its own and one is
        found. The first look waits at most FIRST_WAIT and then goes on in the background."""
        if any(base_lang(s.lang) == "pt" for s in stream.subtitles):
            return None
        ref = reference(stream.subtitles)
        if ref is None or not ref.url.startswith(("http://", "https://")):
            return None
        key = (int(anime["id"]), episode, source)
        stored: dict | None = await self._cache.get(TRACK_NS, list(key))
        if stored is None:
            referer = stream.upstream_headers.get("Referer", "")
            try:
                stored = await asyncio.wait_for(
                    self._fits.run(key, lambda: self._find(anime, episode, source, ref, referer)),
                    FIRST_WAIT,
                )
            except TimeoutError:
                return None
        if stored is None or not stored.get("vtt"):
            return None
        return Subtitle(lang=LANG, label=LABEL, url=f"{SCHEME}{key[0]}/{key[1]}/{key[2]}")

    async def vtt(self, link: str) -> str | None:
        """The fitted track a link names, while it is cached."""
        try:
            anime, episode, source = link.removeprefix(SCHEME).split("/", 2)
            key = [int(anime), int(episode), source]
        except ValueError:
            return None
        stored = await self._cache.get(TRACK_NS, key)
        return stored.get("vtt") if stored else None

    async def _find(
        self, anime: dict, episode: int, source: str, ref: Subtitle, referer: str
    ) -> dict:
        key = [int(anime["id"]), episode, source]
        try:
            stored, ttl = await self._fit_best(anime, episode, source, ref, referer)
        except (httpx.HTTPError, TimeoutError, ApiError, ValueError) as exc:
            log.info(
                "pt-BR subtitles for MAL %s ep %s on %s: lookup failed: %r",
                key[0],
                episode,
                source,
                exc,
            )
            stored, ttl = {"vtt": None}, ERROR_TTL
        await self._cache.set(TRACK_NS, key, stored, ttl)
        return stored

    async def _fit_best(
        self, anime: dict, episode: int, source: str, ref: Subtitle, referer: str
    ) -> tuple[dict, int]:
        files = await self._site.search(anime, episode)
        if not files:
            log.info("pt-BR subtitles for MAL %s ep %s: none found", anime["id"], episode)
            return {"vtt": None}, MISS_TTL
        own = parse_any(await self._reference_text(ref, referer))
        best: tuple[Fit, list[Cue], dict] | None = None
        for file in files:
            text = await self._site.text(file)
            cues = without_adverts(parse_any(text)) if text else []
            placed = await asyncio.to_thread(fit, cues, own) if cues else None
            log.info(
                "pt-BR subtitles for MAL %s ep %s on %s: file %s %s",
                anime["id"],
                episode,
                source,
                file["id"],
                f"fits at {placed.shift:+.2f}s"
                + (f" then {placed.late_shift:+.2f}s" if placed.late_shift is not None else "")
                + f", {placed.matched} lines ({placed.ratio:.0%})"
                if placed
                else "doesn't fit",
            )
            if placed and (best is None or placed.ratio > best[0].ratio):
                best = (placed, cues, file)
        if best is None:
            return {"vtt": None}, MISS_TTL
        placed, cues, file = best
        return {
            "vtt": to_vtt(apply(cues, placed)),
            "file": file["id"],
            "shift": round(placed.shift, 3),
            "ratio": round(placed.ratio, 3),
        }, FOUND_TTL

    async def _reference_text(self, ref: Subtitle, referer: str) -> str:
        """The copy's own track, fetched the way the proxy does (public hosts only, capped)."""
        upstream, _ = await open_upstream(self._http, ref.url, host_headers(referer))
        if upstream.status_code >= 400:
            await upstream.aclose()
            raise ApiError(502, "upstream_failed", f"Subtitle host answered {upstream.status_code}")
        return await read_capped(upstream)


class WithPortugueseSubtitles:
    """A source whose subbed copies gain a fitted pt-BR track when they have none."""

    def __init__(self, name: str, inner: VideoSource, subtitles: PortugueseSubtitles) -> None:
        self.name = name
        self._inner = inner
        self._subtitles = subtitles

    def __getattr__(self, attr: str):
        # Everything else (traits, aclose, ...) is the wrapped source's.
        return getattr(self._inner, attr)

    async def episodes(self, anime: dict, lang: Lang) -> EpisodeList | None:
        return await self._inner.episodes(anime, lang)

    async def stream(self, anime: dict, episode: int, lang: Lang) -> Stream | None:
        found = await self._inner.stream(anime, episode, lang)
        if found is None or lang != "sub" or found.machine_translated:
            return found
        try:
            extra = await self._subtitles.for_stream(anime, episode, self.name, found)
        except Exception:
            log.exception("pt-BR subtitles for MAL %s ep %s failed", anime.get("id"), episode)
            return found
        return replace(found, subtitles=(*found.subtitles, extra)) if extra else found


def with_portuguese_subtitles(
    sources: dict[str, VideoSource], subtitles: PortugueseSubtitles
) -> dict[str, VideoSource]:
    """Wraps every source whose copies don't already show Portuguese burned into the picture."""
    wrapped: dict[str, VideoSource] = {}
    for name, source in sources.items():
        traits = getattr(source, "traits", None)
        burned = traits is not None and base_lang(traits.hard_sub_lang or "") == "pt"
        wrapped[name] = source if burned else WithPortugueseSubtitles(name, source, subtitles)
    return wrapped
