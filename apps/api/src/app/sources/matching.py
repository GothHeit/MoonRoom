"""Matching a MyAnimeList entry to a title on a scraped provider.

Provider-agnostic: the caller passes in how to search and how to fetch alternative names,
so this can be tested without the network.

It searches with the main title plus English, Japanese and synonyms, scores candidates
with token_sort_ratio, falls back to the provider's alternative names (stylised titles,
nicknames like "1P" for One Piece), and penalises sequel/special markers that aren't in
the MAL title so "X Specials" and recaps don't win.
"""

import re
import unicodedata
from collections.abc import Callable, Iterable
from dataclasses import dataclass

from rapidfuzz import fuzz

MIN_RATIO = 70
# For sites full of short titles that share words (adult releases), 70 lets "Harem Camp" take
# "Harem Cult" and "Oni Chichi: Re-birth" take "Re-born".
STRICT_MIN_RATIO = 75
EXACT_ENOUGH = 90
SEQUEL_PENALTY = 25
SEQUEL_MARKERS = (
    "√a",
    ":re",
    "2nd",
    "3rd",
    "season",
    "movie",
    "film",
    "ova",
    "ona",
    "special",
    "part",
    "final",
    "kanketsu",
    "recap",
)


# Titles searched per entry: the main title first, then the English one.
MAX_QUERIES = 2
# Sites that search whole phrases name later seasons "X 2", so a sequel is also searched by its
# title without the season part.
SEASON = re.compile(
    r"\s*:?\s*(?:(\d+)(?:st|nd|rd|th)\s+season|season\s+(\d+)|part\s+(\d+))\s*$",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class Candidate:
    identifier: str
    name: str


def normalize(s: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", s).lower().split())


# MAL hides some words of adult titles ("Futsuma *jo Charlotte", "○-ssia Musume"): a token with
# one of these marks stands for any word that fits around it.
CENSOR_MARKS = "*○●"
CENSORED = re.compile(rf"\S*[{re.escape(CENSOR_MARKS)}]\S*")
# Romanisations that differ only in spelling ("Hikari wo" / "Hikari o").
SPELLINGS = {"wo": "o"}
# A suffix adult releases carry on MAL but often not on the sites ("X The Animation").
DECORATIVE_SUFFIX = re.compile(r"\s+the animation$")
MARK_HYPHEN = re.compile(rf"([{re.escape(CENSOR_MARKS)}])-")
WORD_HYPHEN = re.compile(r"(?<=\w)-(?=\w)")
EDGE_PUNCTUATION = re.compile(r"^\W+|\W+$")
NOT_WORD = re.compile(rf"[^\w\s{re.escape(CENSOR_MARKS)}]+")


def fuzzy_key(s: str, join_hyphens: bool = False) -> str:
    """A title reduced to its words for scoring: no punctuation or symbols (♥, ☆, "!:"), one
    spelling of the common romanisation variants and no "The Animation" suffix. Hyphenated words
    are split, or joined with `join_hyphens` ("Re-born" / "Reborn")."""
    text = MARK_HYPHEN.sub(r"\1", normalize(s).replace("_", " "))
    if join_hyphens:
        text = WORD_HYPHEN.sub("", text)
    words = NOT_WORD.sub(" ", text).split()
    return DECORATIVE_SUFFIX.sub("", " ".join(SPELLINGS.get(w, w) for w in words))


def fuzzy_keys(s: str) -> set[str]:
    return {fuzzy_key(s), fuzzy_key(s, join_hyphens=True)}


def fill_censored(target: str, name: str) -> str:
    """The target with each censored token replaced by the word of `name` it can stand for."""
    if not CENSORED.search(target):
        return target
    words = name.split()
    tokens = target.split()
    out = []
    for i, token in enumerate(tokens):
        if not token.strip(CENSOR_MARKS):
            # A word hidden whole ("** Kouhai") is taken to be the word in the same place, when
            # both titles have as many words; otherwise it is left out.
            if len(words) == len(tokens):
                out.append(words[i])
            continue
        if CENSORED.fullmatch(token):
            parts = [re.escape(p) for p in re.split(rf"[{re.escape(CENSOR_MARKS)}]+", token)]
            pattern = re.compile(r"\w*".join(parts))
            token = next((w for w in words if pattern.fullmatch(w)), token)
        out.append(token)
    return " ".join(out)


def fallback_query(detail: dict) -> str | None:
    """One distinctive word of the main title, for sites whose search needs the exact phrase and
    so miss a title spelled a little differently ("Araiya-san!: Ore to..." vs "Araiya-san! Ore
    to..."). Censored and short words are skipped."""
    for raw in (detail.get("title") or "").split():
        if CENSORED.fullmatch(raw):
            continue
        word = EDGE_PUNCTUATION.sub("", raw)
        if len(word) >= 4:
            return word
    return None


def mal_titles(detail: dict) -> set[str]:
    titles = {detail.get("title") or ""}
    alt = detail.get("alternative_titles") or {}
    for key in ("en", "ja"):
        if alt.get(key):
            titles.add(alt[key])
    titles |= set(alt.get("synonyms") or [])
    return {t for t in titles if t}


def search_queries(detail: dict) -> list[str]:
    alt = detail.get("alternative_titles") or {}
    seen: list[str] = []
    for title in (detail.get("title"), alt.get("en")):
        if title and title not in seen:
            seen.append(title)
    queries = seen[:MAX_QUERIES] or sorted(mal_titles(detail))[:MAX_QUERIES]
    if queries and (stem := SEASON.sub("", queries[0])) and stem not in queries:
        queries.append(stem)
    return queries


def same_season(detail: dict) -> Callable[[str], bool]:
    """Whether a site's title can be this entry's season. A sequel only matches titles carrying
    its number, so the stem search can't pick an earlier season when the site lacks this one."""
    season = SEASON.search(detail.get("title") or "")
    number = next((n for n in season.groups() if n), None) if season else None
    if number is None:
        return lambda _name: True
    numbered = re.compile(rf"\b{number}(?:st|nd|rd|th)?\b")
    return lambda name: bool(numbered.search(name))


def penalty(name: str, mal_joined: str) -> int:
    name_n = normalize(name)
    return sum(SEQUEL_PENALTY for m in SEQUEL_MARKERS if m in name_n and m not in mal_joined)


def _best_ratio(names: Iterable[str], targets: set[str]) -> float:
    keys = [fuzzy_key(n) for n in names]
    return max(
        (fuzz.token_sort_ratio(fill_censored(fuzzy_key(t), k), k) for k in keys for t in targets),
        default=0,
    )


def match(
    detail: dict,
    search: Callable[[str], list[Candidate]],
    alternative_names: Callable[[str], list[str]],
    min_ratio: int = MIN_RATIO,
) -> Candidate | None:
    raw = mal_titles(detail)
    targets = {normalize(t) for t in raw}
    joined = " ".join(targets)

    candidates: dict[str, Candidate] = {}
    for query in raw:
        for c in search(query):
            candidates.setdefault(c.identifier, c)

    best, best_score, best_ratio = None, float("-inf"), 0.0
    for c in candidates.values():
        p = penalty(c.name, joined)
        ratio = _best_ratio([c.name], targets)
        if ratio < EXACT_ENOUGH and p == 0:
            ratio = max(ratio, _best_ratio(alternative_names(c.identifier), targets))
        score = ratio - p
        if score > best_score:
            best, best_score, best_ratio = c, score, ratio

    if best is None or best_ratio < min_ratio:
        return None
    return best
