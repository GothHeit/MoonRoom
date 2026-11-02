import pytest

from app.sources import load_sources
from app.sources.zoko import ZokoSource


def test_retired_source_is_skipped() -> None:
    sources = load_sources(["allanime", "zoko"])
    assert list(sources) == ["zoko"]
    assert isinstance(sources["zoko"], ZokoSource)


def test_unknown_source_fails() -> None:
    with pytest.raises(ValueError):
        load_sources(["nope"])


def test_local_source_needs_a_library_folder(monkeypatch, tmp_path) -> None:
    from app.config import get_settings
    from app.sources.local import LocalSource

    monkeypatch.setattr(get_settings(), "local_library_dir", "")
    monkeypatch.setattr(get_settings(), "local_library_dirs", "")
    with pytest.raises(ValueError, match="LOCAL_LIBRARY_DIRS"):
        load_sources(["local"])
    monkeypatch.setattr(get_settings(), "local_library_dir", str(tmp_path))
    assert isinstance(load_sources(["local"])["local"], LocalSource)
