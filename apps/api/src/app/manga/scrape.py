"""Pieces the scraped manga sources share: a polite HTTP client and fuzzy title matching.

Scraped sites have no MAL link to go by, so a title is matched on its names alone, strictly:
a wrong match would show another manga's chapters under the title.
"""

import html
import re

import httpx
from rapidfuzz import fuzz

from app.sources.matching import mal_titles, normalize

# A plain browser identity: these sites turn away unknown agents.
BROWSER_UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0 Safari/537.36"
)
MIN_RATIO = 90

_TAGS = re.compile(r"<[^>]+>")


def new_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(
        headers={"User-Agent": BROWSER_UA, "Accept-Language": "en,pt-BR;q=0.8"},
        follow_redirects=True,
        timeout=20.0,
    )


def text(fragment: str) -> str:
    """The visible text of a small HTML fragment."""
    return html.unescape(_TAGS.sub("", fragment)).strip()


def search_queries(manga: dict) -> list[str]:
    alt = manga.get("alternative_titles") or {}
    queries: list[str] = []
    for title in (manga.get("title"), alt.get("en"), alt.get("ja")):
        if title and title not in queries:
            queries.append(title)
    return queries[:2]


def best_match(manga: dict, candidates: list[tuple[str, list[str]]]) -> str | None:
    """The key of the candidate whose names are closest to the MAL title, if close enough.
    A candidate is (key, names)."""
    targets = {normalize(t) for t in mal_titles(manga)}
    best, best_ratio = None, 0.0
    for key, names in candidates:
        ratio = max(
            (fuzz.token_sort_ratio(t, normalize(n)) for n in names if n for t in targets),
            default=0,
        )
        if ratio > best_ratio:
            best, best_ratio = key, ratio
    return best if best_ratio >= MIN_RATIO else None


_NUMBER = r"\d+(?:\.\d+)?"


def chapter_number(label: str) -> str:
    """The chapter a label names. "Group 2 Chapter 386" and "Vol.3 Ch.20" are chapter 386 and
    20: the number that follows the word chapter wins, else the first number in the label."""
    after = re.search(
        rf"\b(?:chapter|chap|ch|cap[ií]tulo|cap)\b\.?\s*#?\s*({_NUMBER})", label, re.I
    )
    if after:
        return after.group(1)
    found = re.search(_NUMBER, label)
    return found.group(0) if found else ""


def sort_key(number: str) -> float:
    try:
        return float(number) if number else float("inf")
    except ValueError:
        return float("inf")
