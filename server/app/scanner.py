import os
from sqlmodel import select
from .models import MediaItem, Library
from .db import session

VIDEO_EXTS = {".mp4", ".m4v", ".webm", ".mkv", ".avi", ".mov"}

def scan_library(library_id: int) -> dict:
    """
    Naive scan: walk the library folder, insert new files by path.
    (We’ll upgrade this later with metadata, ffprobe, posters, etc.)
    """
    with session() as s:
        lib = s.get(Library, library_id)
        if not lib:
            return {"ok": False, "error": "library_not_found"}

        added = 0
        skipped = 0
        for root, _, files in os.walk(lib.path):
            for fn in files:
                ext = os.path.splitext(fn)[1].lower()
                if ext not in VIDEO_EXTS:
                    continue
                full_path = os.path.join(root, fn)

                exists = s.exec(select(MediaItem).where(MediaItem.path == full_path)).first()
                if exists:
                    skipped += 1
                    continue

                try:
                    st = os.stat(full_path)
                except OSError:
                    continue

                title = os.path.splitext(fn)[0].replace(".", " ").replace("_", " ").strip()
                item = MediaItem(
                    library_id=lib.id,
                    title=title,
                    path=full_path,
                    ext=ext,
                    size_bytes=st.st_size,
                )
                s.add(item)
                added += 1

        s.commit()
        return {"ok": True, "added": added, "skipped": skipped}
