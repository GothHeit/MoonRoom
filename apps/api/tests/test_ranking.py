from app.ranking import (
    Offer,
    Prefs,
    base_lang,
    bucket,
    is_ideal,
    rank,
)


def offer(source: str, order: int, **kw) -> Offer:
    return Offer(source=source, lang=kw.pop("lang", "sub"), order=order, **kw)


def names(offers: list[Offer], prefs: Prefs) -> list[str]:
    return [f"{o.source}:{o.lang}" for o in rank(offers, prefs)]


def test_language_codes_compare_by_base_language() -> None:
    assert base_lang("pt-BR") == base_lang("por") == base_lang("pt_br") == "pt"
    assert base_lang("jpn") == base_lang("ja-JP") == "ja"
    assert base_lang(None) == base_lang("") == base_lang("und") == "und"


def test_resolutions_round_to_standard_heights() -> None:
    assert [bucket(h) for h in (1080, 1076, 1088, 720, 718, 480, None, 0)] == [
        1080,
        1080,
        1080,
        720,
        720,
        480,
        0,
        0,
    ]


def test_source_order_decides_between_equal_versions() -> None:
    both = [offer("b", 1, resolution=1080), offer("a", 0, resolution=1080)]
    assert names(both, Prefs()) == ["a:sub", "b:sub"]
    # The input order never matters.
    assert names(list(reversed(both)), Prefs()) == ["a:sub", "b:sub"]


def test_soft_portuguese_beats_hard_portuguese_beats_english_soft() -> None:
    soft_pt = offer("soft", 2, soft_subs=frozenset({"pt", "en"}), resolution=720)
    hard_pt = offer("hard", 0, hard_sub="pt", resolution=1080)
    soft_en = offer("en", 1, soft_subs=frozenset({"en"}), resolution=1080)
    assert names([hard_pt, soft_en, soft_pt], Prefs()) == ["soft:sub", "hard:sub", "en:sub"]


def test_hard_subs_tie_with_soft_when_the_viewer_does_not_mind() -> None:
    soft_pt = offer("soft", 2, soft_subs=frozenset({"pt"}), resolution=720)
    hard_pt = offer("hard", 0, hard_sub="pt", resolution=1080)
    assert names([soft_pt, hard_pt], Prefs(soft_subs=False)) == ["hard:sub", "soft:sub"]


def test_language_outranks_quality() -> None:
    sharp_english = offer("hd", 0, soft_subs=frozenset({"en"}), resolution=1080)
    soft_portuguese = offer("pt", 1, soft_subs=frozenset({"pt"}), resolution=480)
    assert names([sharp_english, soft_portuguese], Prefs())[0] == "pt:sub"


def test_chosen_subtitle_language_replaces_the_automatic_one() -> None:
    pt = offer("pt", 0, soft_subs=frozenset({"pt"}), resolution=1080)
    es = offer("es", 1, soft_subs=frozenset({"es"}), resolution=1080)
    assert names([pt, es], Prefs(subtitle="es"))[0] == "es:sub"
    # A language nobody has still falls back to English before nothing.
    en = offer("en", 2, soft_subs=frozenset({"en"}), resolution=480)
    none = offer("none", 3, resolution=1080)
    assert names([none, en], Prefs(subtitle="ko")) == ["en:sub", "none:sub"]


def test_no_subtitles_wanted_avoids_burned_in_ones() -> None:
    burned = offer("burned", 0, hard_sub="pt", resolution=1080)
    clean = offer("clean", 1, soft_subs=frozenset({"en"}), resolution=1080)
    assert names([burned, clean], Prefs(subtitle="off"))[0] == "clean:sub"


def test_wanted_dub_beats_everything_but_a_missing_file() -> None:
    dubbed = offer(
        "dubs", 3, audio=frozenset({"ja", "pt"}), soft_subs=frozenset({"en"}), resolution=720
    )
    subbed = offer("subs", 0, soft_subs=frozenset({"pt"}), resolution=1080)
    assert names([subbed, dubbed], Prefs(audio="pt-BR"))[0] == "dubs:sub"
    # Without asking for a dub, the original audio with Portuguese subtitles wins.
    assert names([subbed, dubbed], Prefs())[0] == "subs:sub"


def test_a_dub_only_stream_is_the_last_resort_for_original_audio() -> None:
    dub_only = offer(
        "dub", 0, lang="dub", audio=frozenset({"pt"}), original_audio=False, resolution=1080
    )
    sub = offer("sub", 1, soft_subs=frozenset({"en"}), resolution=480)
    assert names([dub_only, sub], Prefs()) == ["sub:sub", "dub:dub"]
    assert names([dub_only, sub], Prefs(audio="pt-BR"))[0] == "dub:dub"


def test_a_dub_in_the_wanted_language_needs_no_subtitles() -> None:
    dub = offer("dub", 1, lang="dub", audio=frozenset({"pt"}), original_audio=False)
    other_dub = offer("hdsub", 0, soft_subs=frozenset({"pt"}), resolution=1080)
    # Neither has subtitles to compare on the dub: audio decides, then quality and order.
    assert names([other_dub, dub], Prefs(audio="pt"))[0] == "dub:dub"


def test_resolution_limit_prefers_the_best_under_it() -> None:
    p1080 = offer("a", 0, resolution=1080)
    p720 = offer("b", 1, resolution=720)
    p480 = offer("c", 2, resolution=480)
    assert names([p1080, p720, p480], Prefs()) == ["a:sub", "b:sub", "c:sub"]
    assert names([p1080, p720, p480], Prefs(resolution=720)) == ["b:sub", "c:sub", "a:sub"]
    # Nothing under the limit: the closest above it.
    assert names([p1080, p720], Prefs(resolution=480)) == ["b:sub", "a:sub"]


def test_unchecked_files_come_last() -> None:
    sure = offer("sure", 5, resolution=360)
    unsure = offer("unsure", 0, resolution=1080, verified=False)
    assert names([unsure, sure], Prefs()) == ["sure:sub", "unsure:sub"]


def test_subbed_wins_a_tie_within_one_source() -> None:
    sub = offer("a", 0, resolution=1080)
    dub = offer("a", 0, lang="dub", resolution=1080)
    assert names([dub, sub], Prefs()) == ["a:sub", "a:dub"]


def test_ideal_offer_is_one_nothing_can_improve() -> None:
    great = offer("a", 0, soft_subs=frozenset({"pt"}), resolution=1080)
    assert is_ideal(great, Prefs())
    assert not is_ideal(offer("a", 0, soft_subs=frozenset({"en"}), resolution=1080), Prefs())
    assert not is_ideal(offer("a", 0, soft_subs=frozenset({"pt"}), resolution=720), Prefs())
    # With a limit, the limit's quality is the ideal one.
    assert is_ideal(
        offer("a", 0, soft_subs=frozenset({"pt"}), resolution=720), Prefs(resolution=720)
    )
    assert not is_ideal(great, Prefs(resolution=720))
    assert not is_ideal(offer("a", 0, resolution=1080, verified=False), Prefs(subtitle="off"))
