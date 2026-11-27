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

A lookup never slows playback much: only a play waits for one, at most FIRST_WAIT, and nothing
waits while OpenSubtitles is failing (a breaker skips it for a while). Everything else (the
master playlist, the Language menu's check, warming the next episode) starts the lookup in the
background and moves on.
"""

import asyncio
import logging
import re
import zlib
from bisect import bisect_left, bisect_right
from collections import Counter
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field, replace
from statistics import median
from urllib.parse import quote, urljoin, urlsplit

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
SEARCH_TIMEOUT = 8.0
DOWNLOAD_TIMEOUT = 8.0
# The longest a whole lookup (search, the copy's track, a few files) may run in the background.
LOOKUP_DEADLINE = 30.0
# After OpenSubtitles fails or times out, no lookup is started for this long.
BREAKER_SECONDS = 900.0
MAX_REDIRECTS = 3
# A compressed subtitle file is tens of kilobytes; anything far larger isn't one.
MAX_DOWNLOAD = 1024 * 1024
MAX_TEXT = 4 * 1024 * 1024
# Files tried per episode, best first.
MAX_CANDIDATES = 3
FORMATS = {"srt", "vtt", "ass", "ssa"}

# How long a lookup may hold up the stream being resolved. Only a play sets it (`waiting`).
_WAIT: ContextVar[float] = ContextVar("pt_subtitle_wait", default=0.0)
# Sources whose lookup was still running, for a check that wants to know (`noting_pending`).
_PENDING: ContextVar[list[str] | None] = ContextVar("pt_subtitle_pending", default=None)

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
TRACK_NS = "pt-subtitle-fit-v4"

# Two starts this close count as the same line: what finds the shift and says a file fits.
MATCH = 0.2
# Releases time the same line up to half a second apart (Steins;Gate's fan files run 0.25 s
# ahead of AniZone's through whole scenes), so whether a line is in place, and which shift holds
# where, is judged this loosely. Only lines that meet nothing even then are left out.
PLACE = 0.5
# The largest shift looked for, either way.
MAX_SHIFT = 600.0
BIN = 0.1
# A fit is offered when this share of the lines meets the copy's track, and at least this many.
MIN_RATIO = 0.5
# Or when this share sits within PLACE: the same episode, timed a little apart throughout. A file
# for another episode places at most ~60% that loosely (the opening and ending repeat).
CLOSE_RATIO = 0.75
MIN_MATCHED = 15
# Shifts tried per file, and the lines one must place to be tried.
MAX_PIECES = 4
MIN_PIECE = 5
# What changing shift costs, in lines placed closely: a new piece starts only where it places
# more than this (a close start scores 2, a loose one 1).
SWITCH = 7.0
# Lines that meet nothing are never left out: they are shown at a guess, between the offsets of
# the placed lines on either side (see `Fit.adjust`). A guess further than this from the piece's
# own shift is not trusted: the piece's shift is used instead.
MAX_GUESS_DRIFT = 1.5

# Words that say a file was made by a translation engine. "IA"/"AI" only in capitals: "ia" is
# a common Portuguese word.
MACHINE = re.compile(
    r"google|deepl|machine|autom[aá]tic|auto[- ]?transl|chat ?gpt|\bgpt\b|\bllm\b",
    re.IGNORECASE,
)
MACHINE_ACRONYM = re.compile(r"\b(?:IA|AI|I\.A\.)(?:\b|$)")
# Lines OpenSubtitles or the uploader slip in that aren't the show's.
ADVERT = re.compile(
    r"opensubtitles|osdb\.link|www\.|https?://|vip member|advertise (?:here|your|with)"
    # A bare address ("site.com"), not a sentence trailing off into "...com a gente".
    r"|(?<![.\w-])[a-z0-9-]{2,}\.(?:com|org|net)(?:\.[a-z]{2})?\b(?!\s+[^\W\d_])",
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


@dataclass(frozen=True, eq=False)
class Fit:
    # (cue time it starts at, seconds added) for each piece of the file, in order: one piece
    # when the file only starts at another time, more when a scene was cut or moved.
    pieces: tuple[tuple[float, float], ...]
    matched: int
    ratio: float
    # Seconds to add to the cues that meet nothing on the copy's track (a line the other file
    # splits differently, a stretch that can't be placed with confidence), by cue index: a guess
    # between the offsets of the placed lines around them. Every cue is shown.
    adjust: dict[int, float] = field(default_factory=dict)

    @property
    def shift(self) -> float:
        return self.pieces[0][1]

    def place(self, t: float) -> float:
        moved = self.pieces[0][1]
        for begins, shift in self.pieces:
            if t >= begins:
                moved = shift
        return t + moved


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
    text = text.replace("&", "&amp;").replace("-->", "--&gt;")
    return re.sub(rf"<(?!{ALLOWED_TAG})", "&lt;", text)


def to_vtt(cues: list[Cue]) -> str:
    lines = ["WEBVTT", ""]
    for cue in cues:
        # A blank line would end the cue early.
        text = "\n".join(line for line in _escape(cue.text).split("\n") if line.strip())
        if text:
            lines += [f"{_timestamp(cue.start)} --> {_timestamp(cue.end)}", text, ""]
    return "\n".join(lines)


# --- Fitting a file to the copy ----------------------------------------------------------


def _hits(
    starts: list[float], reference: list[float], shift: float, within: float = MATCH
) -> list[bool]:
    hits = []
    for t in starts:
        moved = t + shift
        i = bisect_left(reference, moved)
        near = [reference[j] for j in (i - 1, i) if 0 <= j < len(reference)]
        hits.append(any(abs(r - moved) <= within for r in near))
    return hits


def _guess_offsets(
    starts: list[float],
    ref: list[float],
    path: list[int],
    shifts: list[float],
    placed: list[bool],
    exact: list[bool],
) -> dict[int, float]:
    """For each line that meets nothing, the offset to show it at: interpolated between the
    offsets of the nearest placed lines before and after it within the same piece (where
    the file's timing drifts), else the piece's own shift. Keyed by position in `starts`."""
    anchors: list[tuple[int, float]] = []
    for i, hit in enumerate(exact):
        if not hit:
            continue
        shift = shifts[path[i]]
        k = bisect_left(ref, starts[i] + shift)
        near = [ref[j] for j in (k - 1, k) if 0 <= j < len(ref)]
        local = min((r - starts[i] for r in near), key=lambda o: abs(o - shift), default=shift)
        anchors.append((i, local if abs(local - shift) <= MAX_GUESS_DRIFT else shift))
    guesses: dict[int, float] = {}
    for i, hit in enumerate(placed):
        if hit:
            continue
        shift = shifts[path[i]]
        before = next(((a, o) for a, o in reversed(anchors) if a < i), None)
        after = next(((a, o) for a, o in anchors if a > i), None)
        if before and after and path[before[0]] == path[i] == path[after[0]]:
            span = starts[after[0]] - starts[before[0]]
            weight = (starts[i] - starts[before[0]]) / span if span > 0 else 0.0
            guesses[i] = before[1] + (after[1] - before[1]) * weight
        elif before and path[before[0]] == path[i]:
            guesses[i] = before[1]
        elif after and path[after[0]] == path[i]:
            guesses[i] = after[1]
        else:
            guesses[i] = shift
    return guesses


def _shifts(starts: list[float], reference: list[float]) -> list[float]:
    """The shifts that place a good number of lines: the main one first, then the shifts of
    pieces that moved (a cold open cut differently, a recap left out)."""
    votes: Counter[int] = Counter()
    for t in starts:
        lo = bisect_left(reference, t - MAX_SHIFT)
        hi = bisect_right(reference, t + MAX_SHIFT)
        for r in reference[lo:hi]:
            votes[round((r - t) / BIN)] += 1
    smooth = {b: votes[b - 1] + votes[b] + votes[b + 1] for b in votes}
    found: list[float] = []
    for b in sorted(smooth, key=lambda b: (-smooth[b], -votes[b])):
        if len(found) == MAX_PIECES or smooth[b] < MIN_PIECE:
            break
        if any(abs(b * BIN - f) < 1.0 for f in found):
            continue
        near = [
            r - t
            for t in starts
            for r in reference[
                bisect_left(reference, t + b * BIN - 0.25) : bisect_right(
                    reference, t + b * BIN + 0.25
                )
            ]
        ]
        found.append(median(near) if near else b * BIN)
    return found


def fit(cues: list[Cue], reference: list[Cue]) -> Fit | None:
    """How to move `cues` onto the copy whose own track is `reference`, or None when they don't
    fit it well enough to be the same episode and cut.

    Each line is placed by one of a few candidate shifts; which shift holds where is chosen for
    the whole file at once (Viterbi), with a cost for changing shift, so a new piece only starts
    where it places several lines the current shift can't."""
    order = sorted(range(len(cues)), key=lambda i: cues[i].start)
    starts = [cues[i].start for i in order]
    ref = sorted(c.start for c in reference)
    if len(starts) < MIN_MATCHED or len(ref) < MIN_MATCHED:
        return None
    shifts = _shifts(starts, ref)
    if not shifts:
        return None
    strict = [_hits(starts, ref, shift) for shift in shifts]
    hits = [_hits(starts, ref, shift, PLACE) for shift in shifts]
    # A close start counts double a loose one, so where the pieces meet is set by close ones.
    gain = [[h + s for h, s in zip(hits[j], strict[j], strict=True)] for j in range(len(shifts))]
    k = len(shifts)
    # score[j]: best total ending on shift j; back[i][j]: the shift before it.
    score = [float(gain[j][0]) for j in range(k)]
    back: list[list[int]] = [list(range(k))]
    for i in range(1, len(starts)):
        row, new = [], []
        for j in range(k):
            prev = max(range(k), key=lambda p: (score[p] - (SWITCH if p != j else 0), p == j))
            row.append(prev)
            new.append(score[prev] - (SWITCH if prev != j else 0) + gain[j][i])
        back.append(row)
        score = new
    j = max(range(k), key=lambda j: score[j])
    path = [j]
    for i in range(len(starts) - 1, 0, -1):
        j = back[i][j]
        path.append(j)
    path.reverse()

    placed = [hits[path[i]][i] for i in range(len(starts))]
    pieces: list[tuple[float, float]] = []
    for i, j in enumerate(path):
        if not pieces or pieces[-1][1] != shifts[j]:
            pieces.append((starts[i] if pieces else 0.0, shifts[j]))
    adjust = {
        order[i]: guess
        for i, guess in _guess_offsets(
            starts, ref, path, shifts, placed, [strict[path[i]][i] for i in range(len(starts))]
        ).items()
    }
    matched = sum(strict[j][i] for i, j in enumerate(path))
    most = min(len(starts), len(ref))
    ratio = matched / most
    # Of the file's own lines: a long file would otherwise place loosely by chance.
    close = sum(placed) / len(starts) >= CLOSE_RATIO
    if matched < MIN_MATCHED or (ratio < MIN_RATIO and not close):
        return None
    return Fit(tuple(pieces), matched, ratio, adjust)


def apply(cues: list[Cue], placed: Fit) -> list[Cue]:
    """Every cue, moved onto the copy. None is left out: one that would start before the video
    does is shown from its very beginning."""
    moved = []
    for i, c in enumerate(cues):
        start = c.start + placed.adjust[i] if i in placed.adjust else placed.place(c.start)
        length = max(c.end - c.start, 0.5)
        start = max(start, 0.0)
        moved.append(replace(c, start=start, end=start + length))
    return sorted(moved, key=lambda c: c.start)


def lines_lost(source: int, adverts: int, output: int) -> int:
    """How many of the file's lines (minus the adverts taken out) are missing from the output."""
    return max(source - adverts - output, 0)


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
    if not row.get("IDSubtitleFile") or not isinstance(row.get("SubDownloadLink"), str):
        return False
    if row.get("SubLanguageID") != "pob" or str(row.get("SeriesEpisode")) != str(episode):
        return False
    if str(row.get("SubAutoTranslation")) == "1" or str(row.get("SubForeignPartsOnly")) == "1":
        return False
    credits = f"{row.get('SubTranslator', '')} {row.get('SubAuthorComment', '')}"
    if MACHINE.search(credits) or MACHINE_ACRONYM.search(credits):
        return False
    if str(row.get("SubSumCD", "1")) != "1" or str(row.get("SubFormat")).lower() not in FORMATS:
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
        "downloads": _count(row.get("SubDownloadsCnt")),
        "hearing": str(row.get("SubHearingImpaired")) == "1",
    }


def _count(value: object) -> int:
    try:
        return int(str(value))
    except ValueError:
        return 0


def _from_site(url: str) -> bool:
    link = urlsplit(url)
    host = link.hostname or ""
    return link.scheme == "https" and (
        host == "opensubtitles.org" or host.endswith(".opensubtitles.org")
    )


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
        self._down_until = 0.0

    @property
    def available(self) -> bool:
        """False for a while after the site failed: lookups aren't started then."""
        return asyncio.get_running_loop().time() >= self._down_until

    def _failed(self, exc: BaseException) -> None:
        """Opens the breaker when the failure says the site as a whole is down or refusing us:
        a timeout, a lost connection, a rate limit, a server error, or a refusal (it answers a
        captcha with 401 when it blocks downloads). A missing file only fails that lookup."""
        if isinstance(exc, httpx.HTTPStatusError):
            code = exc.response.status_code
            if code not in (401, 403, 429) and code < 500:
                return
        elif not isinstance(exc, (TimeoutError, httpx.TransportError)):
            return
        if self.available:
            log.warning("OpenSubtitles failed, skipped for %d min: %r", BREAKER_SECONDS // 60, exc)
        self._down_until = asyncio.get_running_loop().time() + BREAKER_SECONDS

    async def search(self, anime: dict, episode: int) -> list[dict]:
        """The best few pt-BR files for the episode, best first. Raises when the site fails."""
        key = (int(anime["id"]), episode)
        stored = await self._cache.get(SEARCH_NS, list(key))
        if stored is not None:
            return stored["files"]
        try:
            return await self._searches.run(key, lambda: self._search(anime, episode))
        except (httpx.HTTPError, TimeoutError) as exc:
            self._failed(exc)
            raise

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
        try:
            return await self._downloads.run(file["id"], lambda: self._download(file))
        except (httpx.HTTPError, TimeoutError) as exc:
            self._failed(exc)
            raise

    async def _fetch(self, url: str) -> bytes | None:
        """A file from the site, read up to MAX_DOWNLOAD; None when larger or sent elsewhere."""
        for _ in range(MAX_REDIRECTS + 1):
            if not _from_site(url):
                return None
            request = self._http.build_request(
                "GET", url, headers=self._headers, timeout=DOWNLOAD_TIMEOUT
            )
            answer = await self._http.send(request, stream=True, follow_redirects=False)
            try:
                if answer.is_redirect and "location" in answer.headers:
                    url = urljoin(url, answer.headers["location"])
                    continue
                answer.raise_for_status()
                data = bytearray()
                async for chunk in answer.aiter_raw():
                    data += chunk
                    if len(data) > MAX_DOWNLOAD:
                        return None
                return bytes(data)
            finally:
                await answer.aclose()
        return None

    async def _download(self, file: dict) -> str | None:
        data = await self._fetch(file["link"]) or b""
        text: str | None = None
        if data:
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
        # Lookups going on in the background; the loop only holds tasks weakly.
        self._tasks: set[asyncio.Task] = set()

    async def for_stream(
        self, anime: dict, episode: int, source: str, stream: Stream
    ) -> Subtitle | None:
        """A fitted pt-BR track for this copy, when the copy has none of its own and one is
        found. A lookup still running is waited on only as long as `waiting` says (a play), and
        not at all while the site is failing; it goes on in the background either way."""
        if any(base_lang(s.lang) == "pt" for s in stream.subtitles):
            return None
        ref = reference(stream.subtitles)
        if ref is None or not ref.url.startswith(("http://", "https://")):
            return None
        key = (int(anime["id"]), episode, source)
        stored: dict | None = await self._cache.get(TRACK_NS, list(key))
        if stored is None:
            if not self._site.available:
                # Counted as still looking: the answer may change once the site is back.
                if (pending := _PENDING.get()) is not None:
                    pending.append(source)
                return None
            referer = stream.upstream_headers.get("Referer", "")
            job = asyncio.ensure_future(
                self._fits.run(key, lambda: self._find(anime, episode, source, ref, referer))
            )
            self._tasks.add(job)
            job.add_done_callback(self._done)
            wait = _WAIT.get()
            try:
                stored = await asyncio.wait_for(asyncio.shield(job), wait) if wait > 0 else None
            except TimeoutError:
                stored = None
            if stored is None:
                if (pending := _PENDING.get()) is not None:
                    pending.append(source)
                return None
        if not stored.get("vtt"):
            return None
        return Subtitle(lang=LANG, label=LABEL, url=f"{SCHEME}{key[0]}/{key[1]}/{key[2]}")

    def _done(self, job: asyncio.Future) -> None:
        self._tasks.discard(job)
        # Read the outcome, so a lookup that fails after every waiter gave up isn't reported as
        # "exception was never retrieved".
        if not job.cancelled() and (exc := job.exception()) is not None:
            log.info("pt-BR subtitle lookup failed: %r", exc)

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
            stored, ttl = await asyncio.wait_for(
                self._fit_best(anime, episode, source, ref, referer), LOOKUP_DEADLINE
            )
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
        best: tuple[Fit, list[Cue], dict, int] | None = None
        for file in files:
            text = await self._site.text(file)
            everything = parse_any(text) if text else []
            cues = without_adverts(everything)
            placed = await asyncio.to_thread(fit, cues, own) if cues else None
            log.info(
                "pt-BR subtitles for MAL %s ep %s on %s: file %s %s",
                anime["id"],
                episode,
                source,
                file["id"],
                "fits at "
                + ", then ".join(f"{shift:+.2f}s from {at:.0f}s" for at, shift in placed.pieces)
                + f"; {placed.matched} lines ({placed.ratio:.0%}), {len(placed.adjust)} guessed"
                if placed
                else "doesn't fit",
            )
            if placed and (best is None or placed.ratio > best[0].ratio):
                best = (placed, cues, file, len(everything))
        if best is None:
            return {"vtt": None}, MISS_TTL
        placed, cues, file, parsed = best
        out = apply(cues, placed)
        vtt = to_vtt(out)
        # What the viewer gets, counted from the text itself: cues the player will draw.
        written = vtt.count(" --> ")
        lost = lines_lost(len(cues), 0, written)
        if lost:
            log.warning(
                "pt-BR subtitles for MAL %s ep %s on %s: file %s lost %d of %d lines",
                anime["id"],
                episode,
                source,
                file["id"],
                lost,
                len(cues),
            )
        log.info(
            "pt-BR subtitles for MAL %s ep %s on %s: %d lines read, %d adverts or blanks removed, "
            "%d shown",
            anime["id"],
            episode,
            source,
            parsed,
            parsed - len(cues),
            written,
        )
        return {
            "vtt": vtt,
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


@contextmanager
def waiting(seconds: float = FIRST_WAIT) -> Iterator[None]:
    """Within it, resolving a stream waits up to `seconds` for a pt-BR lookup (a play)."""
    token = _WAIT.set(seconds)
    try:
        yield
    finally:
        _WAIT.reset(token)


@contextmanager
def noting_pending() -> Iterator[list[str]]:
    """Within it, the sources whose pt-BR lookup was still running are listed."""
    pending: list[str] = []
    token = _PENDING.set(pending)
    try:
        yield pending
    finally:
        _PENDING.reset(token)
