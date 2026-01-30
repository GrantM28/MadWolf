import os
from sqlmodel import select
from .models import MediaItem, Library, MediaMeta
from .db import session
from .metadata import extract_local_metadata

VIDEO_EXTS = {".mp4", ".m4v", ".webm", ".mkv", ".avi", ".mov"}

def scan_library(library_id: int) -> dict:
    """
    Scan: walk the library folder, insert new files by path.
    Also builds local metadata (no API key) via ffprobe + posters + nfo.
    """
    with session() as s:
        lib = s.get(Library, library_id)
        if not lib:
            return {"ok": False, "error": "library_not_found"}

        added = 0
        skipped = 0
        meta_added = 0

        for root, _, files in os.walk(lib.path):
            for fn in files:
                ext = os.path.splitext(fn)[1].lower()
                if ext not in VIDEO_EXTS:
                    continue

                full_path = os.path.join(root, fn)

                existing = s.exec(select(MediaItem).where(MediaItem.path == full_path)).first()
                if existing:
                    skipped += 1

                    # Backfill metadata if missing
                    mm = s.get(MediaMeta, existing.id)
                    if not mm:
                        m = extract_local_metadata(existing.path, existing.title)
                        mm = MediaMeta(media_id=existing.id, **m)
                        s.add(mm)
                        meta_added += 1
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
                s.flush()  # get item.id without committing

                # Build local metadata
                m = extract_local_metadata(full_path, title)
                mm = MediaMeta(media_id=item.id, **m)
                s.add(mm)

                added += 1
                meta_added += 1

        s.commit()
        return {"ok": True, "added": added, "skipped": skipped, "meta_added": meta_added}
