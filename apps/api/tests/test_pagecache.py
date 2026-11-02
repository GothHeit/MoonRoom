from app.manga.pagecache import PageCache


def test_cache_keeps_the_newest_pages_within_the_cap(tmp_path):
    cache = PageCache(tmp_path, 25)
    cache.put("https://h/1", "image/jpeg", b"x" * 10)
    cache.put("https://h/2", "image/png", b"y" * 10)
    assert cache.get("https://h/1") is not None  # now the most recently used
    cache.put("https://h/3", "image/webp", b"z" * 10)
    assert cache.get("https://h/2") is None  # the least recently used went
    hit = cache.get("https://h/1")
    assert hit is not None and hit[1] == "image/jpeg" and hit[0].read_bytes() == b"x" * 10
    assert cache.get("https://h/3") is not None
    assert cache.size == 20
    # Unknown types and oversized pages are served but never kept.
    cache.put("https://h/svg", "image/svg+xml", b"<svg/>")
    cache.put("https://h/big", "image/jpeg", b"b" * 26)
    assert cache.get("https://h/svg") is None and cache.get("https://h/big") is None


def test_cache_is_rebuilt_from_the_folder(tmp_path):
    PageCache(tmp_path, 100).put("https://h/1", "image/jpeg", b"x" * 10)
    (tmp_path / "notes.txt").write_text("ignored")
    again = PageCache(tmp_path, 100)
    assert again.size == 10 and again.get("https://h/1") is not None
