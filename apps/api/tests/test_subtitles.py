from app.subtitles import ass_to_vtt

SCRIPT = """﻿[Script Info]
Title: x

[V4+ Styles]
Format: Name, Fontname
Style: Default,Arial

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.50,0:00:03.25,Default,,0,0,0,,{\\an8}Hello, world\\Nsecond <line> & more
Dialogue: 0,0:00:00.10,0:00:01.00,Sign,,0,0,0,,{\\p1}m 0 0 l 10 10{\\p0}
Dialogue: 0,0:01:02.00,0:01:03.00,Default,,0,0,0,,{\\i1}Italic{\\i0} text
Comment: 0,0:00:05.00,0:00:06.00,Default,,0,0,0,,not spoken
"""


def test_spoken_lines_become_webvtt_cues() -> None:
    assert ass_to_vtt(SCRIPT) == (
        "WEBVTT\n\n"
        "00:00:01.500 --> 00:00:03.250\nHello, world\nsecond &lt;line> &amp; more\n\n"
        "00:01:02.000 --> 00:01:03.000\nItalic text\n"
    )


def test_a_script_without_events_is_an_empty_track() -> None:
    assert ass_to_vtt("not a subtitle file") == "WEBVTT\n"
