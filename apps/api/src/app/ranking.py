"""Which of the ways to play an episode is best for one viewer.

Every enabled source can offer an episode in a few versions (subbed or dubbed, with some audio
tracks, some subtitles, some qualities). `rank` puts those versions in a total order from the
viewer's preferences, so the same inputs always give the same pick.

The order, strongest rule first. A later rule only decides between versions the earlier ones
rate the same:

1. Playable. A version whose file was checked and exists beats one that couldn't be checked.
2. Audio. The preferred dub language beats the original audio, which beats everything else.
   "Original" as the preference puts the original audio first.
3. Subtitles. Skipped when the preferred dub plays (nothing to read). Otherwise a track in the
   viewer's language beats one in the next fallback (English), and a soft (switchable) track
   beats a burned-in one in the same language when the viewer asked for soft subtitles.
4. Resolution. The best available, or with a limit set, the best at or under it; if nothing is
   under the limit, the smallest above it.
5. Source order, from VIDEO_SOURCES. This is the deterministic tie-break, so two sources with
   equal versions always resolve the same way.
6. Subbed before dubbed.

Languages compare by their base code ("pt-BR" and "por" are both "pt").
"""

from dataclasses import dataclass
from typing import Literal

Lang = Literal["sub", "dub"]

ORIGINAL = "original"
# Anime audio is Japanese unless a version says otherwise.
ORIGINAL_AUDIO = "ja"
# Heights players and hosts round to; resolutions are compared by the bucket they fall in so
# 1076 and 1080 are the same quality.
BUCKETS = (2160, 1440, 1080, 720, 480, 360, 240)

# ISO 639-2 (what HLS masters often carry) to the two-letter base code.
ISO3 = {
    "jpn": "ja",
    "por": "pt",
    "eng": "en",
    "spa": "es",
    "fra": "fr",
    "fre": "fr",
    "ger": "de",
    "deu": "de",
    "ita": "it",
    "rus": "ru",
    "hin": "hi",
    "tam": "ta",
    "tel": "te",
    "ara": "ar",
    "kor": "ko",
    "zho": "zh",
    "chi": "zh",
    "ind": "id",
    "tha": "th",
    "vie": "vi",
    "tur": "tr",
    "pol": "pl",
    "nld": "nl",
    "dut": "nl",
}


def base_lang(tag: str | None) -> str:
    """ "pt-BR", "pt_br", "POR" and "pt" are all "pt". Empty and unknown tags give "und"."""
    if not tag:
        return "und"
    head = tag.strip().lower().replace("_", "-").split("-")[0]
    head = ISO3.get(head, head)
    return head if head.isalpha() and 2 <= len(head) <= 3 and head != "und" else "und"


def bucket(height: int | None) -> int:
    """The standard height a resolution counts as; 0 when unknown."""
    if not height or height <= 0:
        return 0
    return next((b for b in BUCKETS if b <= height * 1.1), BUCKETS[-1])


@dataclass(frozen=True)
class Prefs:
    # "original", or the language of the dub to look for.
    audio: str = ORIGINAL
    # The subtitle language the viewer picked; None is automatic (Portuguese, then English),
    # "off" is none at all.
    subtitle: str | None = None
    # A soft track beats a burned-in one in the same language.
    soft_subs: bool = True
    # The tallest quality the viewer wants (a data limit); None is the best there is.
    resolution: int | None = None

    def subtitle_wishes(self) -> tuple[str, ...]:
        """Subtitle languages in the order the viewer would take them."""
        if self.subtitle == "off":
            return ()
        wanted = base_lang(self.subtitle) if self.subtitle else "pt"
        return (wanted,) if wanted == "en" else (wanted, "en")


@dataclass(frozen=True)
class Offer:
    """One version of an episode that a source can play."""

    source: str
    lang: Lang
    # Position of the source in VIDEO_SOURCES; lower is tried first.
    order: int
    # Base codes of the audio languages the stream carries.
    audio: frozenset[str] = frozenset({ORIGINAL_AUDIO})
    # Whether the original audio is among them.
    original_audio: bool = True
    # Base codes of the switchable subtitle tracks.
    soft_subs: frozenset[str] = frozenset()
    # Base code of the subtitle burned into the picture, if any.
    hard_sub: str | None = None
    resolution: int | None = None
    # False when the host couldn't say whether the file exists.
    verified: bool = True


def audio_fit(offer: Offer, prefs: Prefs) -> int:
    """3: the preferred dub plays. 2: the original audio plays. 1: only some other dub."""
    if prefs.audio != ORIGINAL and base_lang(prefs.audio) in offer.audio:
        return 3
    if offer.original_audio:
        return 2
    return 1


def best_audio(prefs: Prefs) -> int:
    return 3 if prefs.audio != ORIGINAL else 2


def subtitle_fit(offer: Offer, prefs: Prefs) -> int:
    """How well the subtitles suit the viewer, 0 when nothing readable is offered. Languages
    earlier in the wishes weigh more than any soft/hard difference in a later one."""
    if audio_fit(offer, prefs) == 3:
        return best_subtitle(prefs)
    wishes = prefs.subtitle_wishes()
    if not wishes:
        # No subtitles wanted: a burned-in one can't be turned off.
        return 1 if offer.hard_sub is None else 0
    score = 0
    for index, wish in enumerate(wishes):
        weight = (len(wishes) - index) * 2
        if wish in offer.soft_subs:
            score = max(score, weight)
        elif offer.hard_sub == wish:
            score = max(score, weight - 1 if prefs.soft_subs else weight)
    return score


def best_subtitle(prefs: Prefs) -> int:
    wishes = prefs.subtitle_wishes()
    return len(wishes) * 2 if wishes else 1


def resolution_fit(offer: Offer, prefs: Prefs) -> tuple[int, int]:
    height = bucket(offer.resolution)
    if prefs.resolution is None:
        return (1, height)
    limit = bucket(prefs.resolution) or prefs.resolution
    # Within the limit, taller is better; above it, the closest to the limit is.
    return (1, height) if height <= limit else (0, -height)


def sort_key(offer: Offer, prefs: Prefs) -> tuple:
    """Higher is better; ties are impossible for two different (source, lang) pairs."""
    return (
        offer.verified,
        audio_fit(offer, prefs),
        subtitle_fit(offer, prefs),
        resolution_fit(offer, prefs),
        -offer.order,
        offer.lang == "sub",
        # Last resort so equal sources named differently never compare as equal.
        offer.source,
    )


def rank(offers: list[Offer], prefs: Prefs) -> list[Offer]:
    """The offers from best to worst for this viewer."""
    return sorted(offers, key=lambda o: sort_key(o, prefs), reverse=True)


def is_ideal(offer: Offer, prefs: Prefs) -> bool:
    """Whether nothing better can exist on audio, subtitles or quality: waiting for other
    sources can only change the pick between equals, never improve it."""
    top = bucket(prefs.resolution) if prefs.resolution else BUCKETS[2]
    return (
        offer.verified
        and audio_fit(offer, prefs) == best_audio(prefs)
        and subtitle_fit(offer, prefs) == best_subtitle(prefs)
        and bucket(offer.resolution) >= min(top, BUCKETS[2])
        and (prefs.resolution is None or bucket(offer.resolution) <= top)
    )
