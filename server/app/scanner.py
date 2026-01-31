import os
import threading
from datetime import datetime
from sqlmodel import select

from .db import session
from .models import Library, MediaItem, MediaMeta
from .metadata import extract_metadata

VIDEO_EXTS = {".mkv", ".mp4", ".avi", ".mov", ".m4v", ".webm"}

_scan_lock = threading.Lock()

def scan_library(library_id: int, force_meta: bool = False) -> dict:
    # Prevent multiple scans at once (same process)
    if not _scan_lock.acquire(blocking=False):
        return {"ok": False, "error": "scan_already_running"}

    try:
        # Fetch library path in a tiny transaction
        with session() as s:
            lib = s.get(Library, library_id)
            if not lib:
                return {"ok": False, "error": "library_not_found"}
            lib_path = lib.path

        added = 0
        existed = 0
        meta_added = 0
        meta_skipped = 0
        meta_updated = 0

        for root, _, files in os.walk(lib_path):
            for fn in files:
                ext = os.path.splitext(fn)[1].lower()
                if ext not in VIDEO_EXTS:
                    continue

                full_path = os.path.join(root, fn)

                try:
                    st = os.stat(full_path)
                except OSError:
                    continue

                # --- Phase 1: ensure MediaItem exists (short transaction) ---
                needs_meta = False
                item_id = None
                title = os.path.splitext(fn)[0].replace(".", " ").replace("_", " ").strip()

                with session() as s:
                    item = s.exec(select(MediaItem).where(MediaItem.path == full_path)).first()

                    if item:
                        existed += 1
                        item_id = item.id
                        title = item.title or title

                        mm = s.get(MediaMeta, item_id) if item_id else None
                    if mm and not force_meta:
                        complete_enough = bool(
                            (mm.clean_title) and
                            (mm.duration_seconds or mm.video_codec or (mm.width and mm.height)) and
                            (mm.poster_path or mm.plot)
                        )
                        if complete_enough:
                            meta_skipped += 1
                            continue

                        needs_meta = True

                    else:
                        item = MediaItem(
                            library_id=library_id,
                            title=title,
                            path=full_path,
                            ext=ext,
                            size_bytes=st.st_size,
                        )
                        s.add(item)
                        s.commit()
                        s.refresh(item)
                        item_id = item.id
                        added += 1
                        needs_meta = True

                if not needs_meta or not item_id:
                    continue

                # --- Phase 2: slow metadata OUTSIDE any DB lock ---
                meta = extract_metadata(full_path, title)

                # --- Phase 3: upsert MediaMeta (short transaction) ---
                with session() as s:
                    mm = s.get(MediaMeta, item_id)
                    if not mm:
                        s.add(MediaMeta(media_id=item_id, **meta))
                        meta_added += 1
                    else:
                        if force_meta:
                            # overwrite with latest (good for fixing wrong posters/plots)
                            for k, v in meta.items():
                                if v is None:
                                    continue
                                setattr(mm, k, v)
                        else:
                            # Fill missing fields only (don’t overwrite good data)
                            for k, v in meta.items():
                                if v is None:
                                    continue
                                cur = getattr(mm, k, None)
                                if cur in (None, "", 0):
                                    setattr(mm, k, v)
                        mm.updated_at = datetime.utcnow()
                        s.add(mm)
                        meta_updated += 1

                    s.commit()

        return {
            "ok": True,
            "library_id": library_id,
            "added": added,
            "existed": existed,
            "meta_added": meta_added,
            "meta_updated": meta_updated,
            "meta_skipped": meta_skipped,
        }
    finally:
        _scan_lock.release()
