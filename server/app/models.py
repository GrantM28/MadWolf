from __future__ import annotations
from datetime import datetime
from typing import Optional
from sqlmodel import SQLModel, Field

class User(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    username: str = Field(index=True, unique=True)
    password_hash: str
    is_admin: bool = True
    created_at: datetime = Field(default_factory=datetime.utcnow)

class Library(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    name: str
    path: str  # absolute path INSIDE container, under MADWOLF_MEDIA_ROOT
    created_at: datetime = Field(default_factory=datetime.utcnow)

class MediaItem(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    library_id: int = Field(index=True)
    title: str
    path: str  # absolute path inside container
    ext: str
    size_bytes: int
    created_at: datetime = Field(default_factory=datetime.utcnow)

class MediaMeta(SQLModel, table=True):
    media_id: int = Field(primary_key=True)  # 1:1 with MediaItem.id

    clean_title: str | None = None
    year: int | None = None
    plot: str | None = None

    duration_seconds: int | None = None
    width: int | None = None
    height: int | None = None
    video_codec: str | None = None
    audio_codec: str | None = None
    audio_channels: int | None = None

    poster_path: str | None = None  # absolute path inside container

    updated_at: datetime = Field(default_factory=datetime.utcnow, index=True)


class WatchEvent(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    user_id: int = Field(index=True)
    media_id: int = Field(index=True)
    position_seconds: int = 0
    duration_seconds: int = 0
    updated_at: datetime = Field(default_factory=datetime.utcnow, index=True)
