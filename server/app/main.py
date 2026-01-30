import os
from fastapi import FastAPI, Request, BackgroundTasks, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from sqlmodel import select

from .db import init_db, session
from .models import User, Library, MediaItem, WatchEvent
from .security import hash_pw, verify_pw, create_session_token, verify_session_token, COOKIE_NAME
from .scanner import scan_library
from .streaming import serve_file_with_range
from . import recs

MEDIA_ROOT = os.getenv("MADWOLF_MEDIA_ROOT", "/mnt/user")

app = FastAPI(title="MadWolf")

# Serve the web UI
app.mount("/assets", StaticFiles(directory="web", html=False), name="assets")

@app.on_event("startup")
def _startup():
    init_db()
    os.makedirs(MEDIA_ROOT, exist_ok=True)

def current_user_id(request: Request) -> int:
    token = request.cookies.get(COOKIE_NAME)
    uid = verify_session_token(token) if token else None
    if not uid:
        raise HTTPException(status_code=401, detail="unauthorized")
    return uid

def needs_setup() -> bool:
    with session() as s:
        u = s.exec(select(User)).first()
        return u is None

@app.get("/")
def index():
    return FileResponse("web/index.html")

@app.get("/styles.css")
def styles():
    return FileResponse("web/styles.css")

@app.get("/app.js")
def js():
    return FileResponse("web/app.js")

# -------- Setup --------
class SetupBody(BaseModel):
    username: str
    password: str

@app.get("/api/setup/status")
def setup_status():
    return {"needsSetup": needs_setup(), "mediaRoot": MEDIA_ROOT}

@app.post("/api/setup/init")
def setup_init(body: SetupBody):
    if not needs_setup():
        raise HTTPException(status_code=400, detail="already_configured")

    if len(body.username) < 3 or len(body.password) < 8:
        raise HTTPException(status_code=400, detail="weak_credentials")

    with session() as s:
        user = User(username=body.username, password_hash=hash_pw(body.password), is_admin=True)
        s.add(user)
        s.commit()
        return {"ok": True}

# -------- Auth --------
class LoginBody(BaseModel):
    username: str
    password: str

@app.post("/api/auth/login")
def login(body: LoginBody):
    with session() as s:
        user = s.exec(select(User).where(User.username == body.username)).first()
        if not user or not verify_pw(body.password, user.password_hash):
            raise HTTPException(status_code=401, detail="bad_credentials")

        token = create_session_token(user.id)
        resp = JSONResponse({"ok": True, "username": user.username})
        resp.set_cookie(
            COOKIE_NAME,
            token,
            httponly=True,
            samesite="lax",
            secure=False,  # set True when behind HTTPS
            max_age=60 * 60 * 24 * 14,
        )
        return resp

@app.post("/api/auth/logout")
def logout():
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(COOKIE_NAME)
    return resp

# -------- Libraries --------
class LibraryCreate(BaseModel):
    name: str
    path: str  # must be under MEDIA_ROOT

def _validate_library_path(p: str) -> str:
    p = os.path.abspath(p)
    mr = os.path.abspath(MEDIA_ROOT)
    if not p.startswith(mr):
        raise HTTPException(status_code=400, detail=f"path_must_be_under_media_root:{mr}")
    if not os.path.isdir(p):
        raise HTTPException(status_code=400, detail="path_not_a_directory")
    return p

def _discover_media_folders():
    mr = os.path.abspath(MEDIA_ROOT)

    # Unraid/system shares you DON'T want in the dropdown
    ignore = {
        "@eaDir", "#recycle", "lost+found",
        "appdata", "domains", "system", "isos",
        "flash", "boot", "backups", "tmp"
    }

    out = []
    try:
        with os.scandir(mr) as it:
            for e in it:
                if not e.is_dir(follow_symlinks=False):
                    continue
                name = e.name

                # ignore hidden + system shares
                if name.startswith(".") or name in ignore:
                    continue

                out.append({"label": name, "path": os.path.join(mr, name)})
    except FileNotFoundError:
        return []

    out.sort(key=lambda x: x["label"].lower())
    return out


@app.get("/api/libraries/discover")
def discover_libraries(request: Request):
    _ = current_user_id(request)
    return {
        "mediaRoot": MEDIA_ROOT,
        "folders": _discover_media_folders(),
    }


@app.get("/api/libraries")
def list_libraries(request: Request):
    _ = current_user_id(request)
    with session() as s:
        libs = s.exec(select(Library).order_by(Library.created_at.desc())).all()
        return {"libraries": libs, "mediaRoot": MEDIA_ROOT}

@app.post("/api/libraries")
def create_library(request: Request, body: LibraryCreate):
    _ = current_user_id(request)
    path = _validate_library_path(body.path)
    with session() as s:
        lib = Library(name=body.name.strip() or "Library", path=path)
        s.add(lib)
        s.commit()
        s.refresh(lib)
        return {"ok": True, "library": lib}

# -------- Scanning --------
@app.post("/api/libraries/{library_id}/scan")
def scan(request: Request, library_id: int, bg: BackgroundTasks):
    _ = current_user_id(request)
    # background scan so UI doesn't hang
    results = {"ok": True, "queued": True}
    bg.add_task(scan_library, library_id)
    return results

# -------- Items --------
@app.get("/api/items")
def list_items(request: Request, library_id: int | None = None, q: str | None = None, limit: int = 200, offset: int = 0):
    _ = current_user_id(request)
    with session() as s:
        stmt = select(MediaItem).order_by(MediaItem.created_at.desc())
        if library_id:
            stmt = stmt.where(MediaItem.library_id == library_id)
        if q:
            stmt = stmt.where(MediaItem.title.like(f"%{q}%"))
        items = s.exec(stmt.offset(offset).limit(limit)).all()
        return {"items": items}

@app.get("/api/items/{item_id}")
def get_item(request: Request, item_id: int):
    _ = current_user_id(request)
    with session() as s:
        it = s.get(MediaItem, item_id)
        if not it:
            raise HTTPException(status_code=404, detail="not_found")
        return {"item": it}

@app.get("/api/items/{item_id}/file")
def stream_item(request: Request, item_id: int):
    _ = current_user_id(request)
    with session() as s:
        it = s.get(MediaItem, item_id)
        if not it:
            raise HTTPException(status_code=404, detail="not_found")
        return serve_file_with_range(request, it.path)

# -------- Watch tracking + “AI rows” plumbing --------
class ProgressBody(BaseModel):
    position_seconds: int
    duration_seconds: int

@app.post("/api/items/{item_id}/progress")
def set_progress(request: Request, item_id: int, body: ProgressBody):
    uid = current_user_id(request)
    with session() as s:
        it = s.get(MediaItem, item_id)
        if not it:
            raise HTTPException(status_code=404, detail="not_found")

        ev = s.exec(select(WatchEvent).where(WatchEvent.user_id == uid, WatchEvent.media_id == item_id)).first()
        if not ev:
            ev = WatchEvent(user_id=uid, media_id=item_id)

        ev.position_seconds = max(0, int(body.position_seconds))
        ev.duration_seconds = max(0, int(body.duration_seconds))
        s.add(ev)
        s.commit()
        return {"ok": True}

@app.get("/api/rows/continue-watching")
def row_continue(request: Request):
    uid = current_user_id(request)
    return {"items": recs.continue_watching(uid)}

@app.get("/api/rows/because-you-watched")
def row_because(request: Request, item_id: int):
    uid = current_user_id(request)
    items = recs.because_you_watched(uid, item_id)
    return {"items": items}
