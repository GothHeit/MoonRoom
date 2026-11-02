"""Subtitle formats the player's own track element can't read."""

import re

# {\an8}, {\pos(1,2)} and other override blocks; a drawing block carries vector shapes.
OVERRIDES = re.compile(r"\{[^}]*\}")
DRAWING = re.compile(r"\{[^}]*\\p[1-9][^}]*\}")


def _timestamp(value: str) -> str | None:
    """ASS "0:01:23.45" to WebVTT "00:01:23.450"."""
    try:
        hours, minutes, seconds = value.strip().split(":")
        whole, _, fraction = seconds.partition(".")
        return f"{int(hours):02d}:{int(minutes):02d}:{int(whole):02d}.{(fraction + '00')[:2]}0"
    except ValueError:
        return None


def ass_to_vtt(text: str) -> str:
    """The spoken lines of an ASS script as WebVTT, without styling: the plain fallback for
    players that can't draw ASS. Drawings (signs made of vector shapes) are dropped."""
    fields: list[str] = []
    cues: list[tuple[str, str, str]] = []
    in_events = False
    for raw in text.lstrip("﻿").splitlines():
        line = raw.strip()
        if line.startswith("["):
            in_events = line.lower() == "[events]"
        elif in_events and line.lower().startswith("format:"):
            fields = [f.strip().lower() for f in line.split(":", 1)[1].split(",")]
        elif in_events and fields and line.lower().startswith("dialogue:"):
            parts = line.split(":", 1)[1].lstrip().split(",", len(fields) - 1)
            row = dict(zip(fields, parts, strict=False))
            start, end = _timestamp(row.get("start", "")), _timestamp(row.get("end", ""))
            body = row.get("text", "")
            if start is None or end is None or DRAWING.search(body):
                continue
            body = OVERRIDES.sub("", body).replace("\\N", "\n").replace("\\n", "\n")
            body = body.replace("\\h", " ").strip()
            body = body.replace("&", "&amp;").replace("<", "&lt;")
            if body:
                cues.append((start, end, body))
    cues.sort(key=lambda cue: cue[0])
    lines = ["WEBVTT", ""]
    for start, end, body in cues:
        lines += [f"{start} --> {end}", body, ""]
    return "\n".join(lines)
