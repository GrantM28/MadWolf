from sqlmodel import select
from .db import session
from .models import WatchEvent, MediaItem

def because_you_watched(user_id: int, media_id: int, limit: int = 20):
    """
    MVP “recommendations” (not ML yet):
    - find other items in the same library with similar title tokens
    This is intentionally dumb-but-works. We’ll swap this for embeddings later.
    """
    with session() as s:
        base = s.get(MediaItem, media_id)
        if not base:
            return []

        base_tokens = set(t.lower() for t in base.title.split() if len(t) > 2)

        items = s.exec(
            select(MediaItem).where(MediaItem.library_id == base.library_id, MediaItem.id != media_id)
        ).all()

        scored = []
        for it in items:
            tks = set(t.lower() for t in it.title.split() if len(t) > 2)
            if not tks or not base_tokens:
                continue
            # Jaccard
            score = len(base_tokens & tks) / max(1, len(base_tokens | tks))
            if score > 0:
                scored.append((score, it))

        scored.sort(key=lambda x: x[0], reverse=True)
        return [it for _, it in scored[:limit]]

def continue_watching(user_id: int, limit: int = 20):
    with session() as s:
        events = s.exec(
            select(WatchEvent)
            .where(WatchEvent.user_id == user_id)
            .order_by(WatchEvent.updated_at.desc())
        ).all()

        # unique by media_id, newest first
        seen = set()
        out = []
        for ev in events:
            if ev.media_id in seen:
                continue
            seen.add(ev.media_id)
            item = s.get(MediaItem, ev.media_id)
            if item:
                out.append({"item": item, "position_seconds": ev.position_seconds, "duration_seconds": ev.duration_seconds})
            if len(out) >= limit:
                break
        return out
