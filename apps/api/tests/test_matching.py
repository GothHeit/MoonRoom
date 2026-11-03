from app.sources.matching import Candidate, match

DETAIL = {
    "id": 21,
    "title": "One Piece",
    "alternative_titles": {"en": "One Piece", "ja": "ONE PIECE", "synonyms": ["OP"]},
}


def fake_search(results):
    return lambda query: results


def test_prefers_main_series_over_specials():
    results = [
        Candidate("a", "One Piece Special: Adventure of Nebulandia"),
        Candidate("b", "One Piece"),
        Candidate("c", "One Piece Film: Red"),
    ]
    best = match(DETAIL, fake_search(results), lambda _: [])
    assert best is not None
    assert best.identifier == "b"


def test_uses_alternative_names_for_stylised_titles():
    results = [Candidate("x", "1P")]
    alt = {"x": ["One Piece"]}
    best = match(DETAIL, fake_search(results), lambda i: alt.get(i, []))
    assert best is not None
    assert best.identifier == "x"


def test_returns_none_when_nothing_is_close():
    results = [Candidate("z", "Completely Different Show")]
    assert match(DETAIL, fake_search(results), lambda _: []) is None


def adult(title):
    return {"id": 1, "title": title, "alternative_titles": {}}


def test_censored_word_takes_the_word_that_fits():
    from app.sources.matching import STRICT_MIN_RATIO

    results = [Candidate("a", "Futsuma Shoujo Charlotte"), Candidate("b", "Futsuma Kishi")]
    best = match(adult("Futsuma *jo Charlotte"), fake_search(results), lambda _: [], 75)
    assert best is not None and best.identifier == "a"
    hidden = [Candidate("c", "Katainaka Ni Totsui De Kita Russia Musume")]
    title = "Katainaka ni Totsuidekita ○-ssia Musume"
    assert match(adult(title), fake_search(hidden), lambda _: [], STRICT_MIN_RATIO)
    whole = [Candidate("d", "Enjo Kouhai")]
    assert match(adult("** Kouhai"), fake_search(whole), lambda _: [], STRICT_MIN_RATIO)


def test_symbols_suffix_and_spelling_dont_count():
    from app.sources.matching import fuzzy_key

    assert fuzzy_key("Itadaki! Seieki♥ The Animation") == "itadaki seieki"
    assert fuzzy_key("Rance 01: Hikari wo Motomete") == fuzzy_key("Rance 01: Hikari o Motomete")
    assert fuzzy_key("Oni Chichi: Re-born", join_hyphens=True) == "oni chichi reborn"


def test_strict_bar_rejects_near_miss_short_titles():
    from app.sources.matching import STRICT_MIN_RATIO

    results = [Candidate("a", "Harem Cult")]
    assert match(adult("Harem Camp!"), fake_search(results), lambda _: [], STRICT_MIN_RATIO) is None


def test_fallback_query_skips_censored_and_short_words():
    from app.sources.matching import fallback_query

    assert fallback_query(adult("Futsuma *jo Charlotte")) == "Futsuma"
    assert fallback_query(adult("** Kouhai")) == "Kouhai"
    assert fallback_query(adult("Araiya-san!: Ore to")) == "Araiya-san"
    assert fallback_query(adult("Oni")) is None
