"""A size-capped disk cache for chapter pages.

Page hosts are slow and their links expire, so a page is kept on disk once fetched and served
from there to the next reader (or the same one re-opening the chapter). The cache is a folder
of files named by the hash of the page URL; the oldest-used files go when the cap is reached.
All file work is blocking and runs in a thread, so the index is guarded by a lock.
"""

import hashlib
import logging
import os
import threading
import time
from collections import OrderedDict
from pathlib import Path

log = logging.getLogger(__name__)

EXTENSIONS = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/avif": "avif",
}
TYPES = {ext: mime for mime, ext in EXTENSIONS.items()}
# A page bigger than this is served but not kept.
MAX_PAGE_BYTES = 20 * 1024 * 1024


class PageCache:
    def __init__(self, root: Path, max_bytes: int) -> None:
        self._root = root
        self._max = max_bytes
        # Name -> size, least recently used first.
        self._files: OrderedDict[str, int] = OrderedDict()
        self._size = 0
        # Requests read and write from worker threads at once: the index changes under the lock.
        self._lock = threading.Lock()
        self._root.mkdir(parents=True, exist_ok=True)
        with self._lock:
            self._scan()

    @property
    def size(self) -> int:
        return self._size

    def _scan(self) -> None:
        entries = []
        for path in self._root.iterdir():
            if path.is_file() and path.suffix[1:] in TYPES:
                info = path.stat()
                entries.append((info.st_mtime, path.name, info.st_size))
        for _, name, size in sorted(entries):
            self._files[name] = size
            self._size += size
        self._evict()

    @staticmethod
    def _stem(url: str) -> str:
        return hashlib.sha256(url.encode()).hexdigest()[:40]

    def get(self, url: str) -> tuple[Path, str] | None:
        """The cached file and its media type, marking it as just used."""
        stem = self._stem(url)
        with self._lock:
            for ext, mime in TYPES.items():
                name = f"{stem}.{ext}"
                if name in self._files:
                    path = self._root / name
                    try:
                        os.utime(path, None)
                    except OSError:
                        self._forget(name)
                        return None
                    self._files.move_to_end(name)
                    return path, mime
        return None

    def put(self, url: str, media_type: str, data: bytes) -> None:
        ext = EXTENSIONS.get(media_type)
        if ext is None or len(data) > MAX_PAGE_BYTES or len(data) > self._max:
            return
        name = f"{self._stem(url)}.{ext}"
        path = self._root / name
        tmp = path.with_name(f"{name}.{os.getpid()}.{time.monotonic_ns()}.part")
        try:
            tmp.write_bytes(data)
            os.replace(tmp, path)
        except OSError as exc:
            log.warning("page cache: could not write %s: %s", name, exc)
            tmp.unlink(missing_ok=True)
            return
        with self._lock:
            self._forget(name)
            self._files[name] = len(data)
            self._size += len(data)
            self._evict()

    def _forget(self, name: str) -> None:
        if name in self._files:
            self._size -= self._files.pop(name)

    def _evict(self) -> None:
        while self._size > self._max and self._files:
            name, size = self._files.popitem(last=False)
            self._size -= size
            try:
                (self._root / name).unlink()
            except OSError as exc:
                log.warning("page cache: could not remove %s: %s", name, exc)
