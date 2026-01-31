import os
import re
import json
import subprocess
import difflib
import urllib.parse
import urllib.request
from xml.etree import ElementTree as ET
from datetime import datetime

# --- TMDB config (v3 api_key query param) ---
TMDB_API_KEY = os.getenv("TMDB_API_KEY", "").strip()
TMDB_BASE = "https://api.themoviedb.org/3"
TMDB_IMG = "https://image.tmdb.org/t/p"  # use /w500 or /original

# --- Video + cleanup ---
VIDEO_EXTS = {".mkv", ".mp4", ".avi", ".mov", ".m4v", ".webm"}

DROP = {
    "1080p","2160p","720p","480p","4k","hdr","dv","dolby","vision","atmos",
    "webrip","web-dl","webdl","bluray","bdrip","brip","dvdrip","hdrip",
    "x264","x265","h264","h265","hevc","avc",
    "aac","ac3","dts","truehd","eac3","flac","mp3",
    "yify","yts","rarbg","etrg","evo",
    "proper","repack","remux","extended","unrated","limited","complete",
}

# We keep folder/cover art BUT only for single-movie folders (prevents "collection poster used for everything")
ART_NAMES_SPECIFIC = [
    "poster.jpg","poster.png",
    "movie.jpg","movie.png",
]
ART_NAMES_GENERIC = [
    "folder.jpg","folder.png",
    "cover.jpg","cover.png",
]

_EP_RE = re.compile(r"(?:^|[ ._\-])s(?P<s>\d{1,2})e(?P<e>\d{1,2})(?:$|[ ._\-])", re.I)
_EP_RE2 = re.compile(r"(?:^|[ ._\-])(?P<s>\d{1,2})x(?P<e>\d{1,2})(?:$|[ ._\-])", re.I)


# -------------------------
# Local metadata helpers
# -------------------------
def clean_title_year(filename_no_ext: str) -> tuple[str, int | None]:
    s = filename_no_ext.replace(".", " ").replace("_", " ")
    s = re.sub(r"\[[^\]]*\]", " ", s)  # remove [groups]

    year = None
    m = re.search(r"\b(19\d{2}|20\d{2})\b", s)
    if m:
        year = int(m.group(1))

    parts = []
    for w in re.split(r"\s+", s):
        w = w.strip(" -_.")
        if not w:
            continue
        lw = w.lower()

        if year and lw == str(year):
            continue
        if lw in DROP:
            continue
        if re.fullmatch(r"\d{3,4}p", lw):
            continue
        if re.fullmatch(r"\d{1,2}bit", lw):
            continue
        if re.fullmatch(r"\d\.\d", lw):  # 5.1, 7.1 etc
            continue

        parts.append(w)

    title = " ".join(parts)
    title = re.sub(r"\s+", " ", title).strip()
    return (title or filename_no_ext, year)


def _dir_video_count(d: str) -> int:
    try:
        c = 0
        for fn in os.listdir(d):
            ext = os.path.splitext(fn)[1].lower()
            if ext in VIDEO_EXTS:
                c += 1
        return c
    except OSError:
        return 0


def find_nfo(media_path: str) -> str | None:
    d = os.path.dirname(media_path)
    base = os.path.splitext(os.path.basename(media_path))[0]
    direct = os.path.join(d, f"{base}.nfo")
    if os.path.isfile(direct):
        return direct
    for fn in os.listdir(d):
        if fn.lower().endswith(".nfo"):
            p = os.path.join(d, fn)
            if os.path.isfile(p):
                return p
    return None


def parse_nfo(nfo_path: str) -> dict:
    try:
        txt = open(nfo_path, "r", encoding="utf-8", errors="ignore").read().strip()
    except OSError:
        return {}

    if "<" not in txt or ">" not in txt:
        return {}

    try:
        root = ET.fromstring(txt)
    except ET.ParseError:
        return {}

    movie = root
    if root.tag.lower() != "movie":
        m = root.find("movie")
        if m is not None:
            movie = m

    def t(name: str) -> str | None:
        v = movie.findtext(name)
        if v is None:
            return None
        v = v.strip()
        return v or None

    out = {}
    title = t("title") or t("originaltitle")
    year = t("year")
    plot = t("plot") or t("outline")

    if title:
        out["title"] = title
    if year and year.isdigit():
        out["year"] = int(year)
    if plot:
        out["plot"] = plot

    return out


def find_poster(media_path: str) -> str | None:
    d = os.path.dirname(media_path)
    base = os.path.splitext(os.path.basename(media_path))[0]

    # prefer filename-matched posters if they exist
    specific = [
        f"{base}.jpg", f"{base}.png",
        f"{base}-poster.jpg", f"{base}-poster.png",
    ]
    for fn in specific:
        p = os.path.join(d, fn)
        if os.path.isfile(p):
            return p

    # Specific names inside folder
    for fn in ART_NAMES_SPECIFIC:
        p = os.path.join(d, fn)
        if os.path.isfile(p):
            return p

    # Generic folder art ONLY if the folder looks like a single-movie folder
    if _dir_video_count(d) <= 1:
        for fn in ART_NAMES_GENERIC:
            p = os.path.join(d, fn)
            if os.path.isfile(p):
                return p

    # parent dir generic art only if parent is a single-movie style folder too
    parent = os.path.dirname(d)
    if _dir_video_count(parent) <= 1:
        for fn in (ART_NAMES_SPECIFIC + ART_NAMES_GENERIC):
            p = os.path.join(parent, fn)
            if os.path.isfile(p):
                return p

    return None


def probe_ffprobe(media_path: str) -> dict:
    cmd = [
        "ffprobe",
        "-v", "error",
        "-print_format", "json",
        "-show_format",
        "-show_streams",
        media_path,
    ]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=20)
    except Exception:
        return {}

    if r.returncode != 0 or not r.stdout.strip():
        return {}

    try:
        data = json.loads(r.stdout)
    except json.JSONDecodeError:
        return {}

    out = {}

    try:
        dur = float(data.get("format", {}).get("duration", 0) or 0)
        if dur > 0:
            out["duration_seconds"] = int(dur)
    except Exception:
        pass

    streams = data.get("streams") or []
    v = next((s for s in streams if s.get("codec_type") == "video"), None)
    a = next((s for s in streams if s.get("codec_type") == "audio"), None)

    if v:
        out["video_codec"] = v.get("codec_name")
        out["width"] = v.get("width")
        out["height"] = v.get("height")

    if a:
        out["audio_codec"] = a.get("codec_name")
        out["audio_channels"] = a.get("channels")

    return out


def extract_local_metadata(media_path: str, fallback_title: str) -> dict:
    base = os.path.splitext(os.path.basename(media_path))[0]
    clean_title, year = clean_title_year(base)

    meta = {
        "clean_title": clean_title or fallback_title,
        "year": year,
        "poster_path": find_poster(media_path),
    }

    nfo = find_nfo(media_path)
    if nfo:
        parsed = parse_nfo(nfo)
        if parsed.get("title"):
            meta["clean_title"] = parsed["title"]
        if parsed.get("year"):
            meta["year"] = parsed["year"]
        if parsed.get("plot"):
            meta["plot"] = parsed["plot"]

    meta.update(probe_ffprobe(media_path))
    return meta


# -------------------------
# TMDB helpers
# -------------------------
_tmdb_cache: dict[tuple, dict] = {}

def _tmdb_get_json(path: str, params: dict) -> dict:
    if not TMDB_API_KEY:
        return {}

    params = dict(params or {})
    params["api_key"] = TMDB_API_KEY

    url = f"{TMDB_BASE}{path}?{urllib.parse.urlencode(params)}"
    key = ("GET", url)
    if key in _tmdb_cache:
        return _tmdb_cache[key]

    req = urllib.request.Request(
        url,
        headers={
            "Accept": "application/json",
            "User-Agent": "MadWolf/1.0",
        },
        method="GET",
    )

    try:
        with urllib.request.urlopen(req, timeout=12) as resp:
            data = json.loads(resp.read().decode("utf-8", errors="ignore"))
    except Exception:
        data = {}

    _tmdb_cache[key] = data
    return data


def _sim(a: str, b: str) -> float:
    a = (a or "").lower().strip()
    b = (b or "").lower().strip()
    if not a or not b:
        return 0.0
    return difflib.SequenceMatcher(None, a, b).ratio()


def _pick_best(results: list[dict], query_title: str, year_hint: int | None, title_key: str, date_key: str) -> dict | None:
    best = None
    best_score = -1.0

    for r in results or []:
        t = r.get(title_key) or ""
        score = _sim(query_title, t)

        # year proximity bonus
        y = None
        dt = r.get(date_key) or ""
        if len(dt) >= 4 and dt[:4].isdigit():
            y = int(dt[:4])

        if year_hint and y:
            diff = abs(year_hint - y)
            score += max(0.0, 0.25 - (diff * 0.05))  # 0 diff => +0.25, 1 => +0.20, etc.

        if score > best_score:
            best_score = score
            best = r

    # don't accept garbage matches
    if best_score < 0.55:
        return None
    return best


def _download_tmdb_poster(media_path: str, poster_rel: str, tag: str) -> str | None:
    """
    Save posters next to the media file under: <dir>/.madwolf/<tag>.jpg
    This keeps it inside MEDIA_ROOT, so your existing poster endpoint can serve it safely.
    """
    if not poster_rel:
        return None

    try:
        d = os.path.dirname(media_path)
        out_dir = os.path.join(d, ".madwolf")
        os.makedirs(out_dir, exist_ok=True)

        dest = os.path.join(out_dir, f"{tag}.jpg")
        if os.path.isfile(dest) and os.path.getsize(dest) > 10_000:
            return dest

        url = f"{TMDB_IMG}/w500{poster_rel}"
        req = urllib.request.Request(url, headers={"User-Agent": "MadWolf/1.0"})
        with urllib.request.urlopen(req, timeout=20) as resp:
            data = resp.read()

        # very basic sanity
        if not data or len(data) < 5000:
            return None

        with open(dest, "wb") as f:
            f.write(data)

        return dest
    except Exception:
        return None


def _parse_episode_marker(name_no_ext: str):
    m = _EP_RE.search(name_no_ext)
    if not m:
        m = _EP_RE2.search(name_no_ext)
    if not m:
        return None

    season = int(m.group("s"))
    ep = int(m.group("e"))

    # everything before marker is show name-ish
    prefix = name_no_ext[:m.start()].strip(" ._-")
    show_title, _ = clean_title_year(prefix)
    if not show_title:
        return None
    return (show_title, season, ep)


def tmdb_enrich(media_path: str, local_meta: dict) -> dict:
    """
    Returns a dict with some/all of: clean_title, year, plot, poster_path, duration_seconds
    """
    if not TMDB_API_KEY:
        return {}

    base = os.path.splitext(os.path.basename(media_path))[0]

    # --- TV episode detection ---
    ep = _parse_episode_marker(base)
    if ep:
        show_title, season, episode = ep

        search = _tmdb_get_json("/search/tv", {"query": show_title})
        best = _pick_best(search.get("results") or [], show_title, None, "name", "first_air_date")
        if not best:
            return {}

        tv_id = best.get("id")
        if not tv_id:
            return {}

        # show details (for poster)
        tv_details = _tmdb_get_json(f"/tv/{tv_id}", {})
        poster_rel = tv_details.get("poster_path") or best.get("poster_path") or ""

        # episode details
        ep_details = _tmdb_get_json(f"/tv/{tv_id}/season/{season}/episode/{episode}", {})
        ep_name = ep_details.get("name") or ""
        ep_plot = ep_details.get("overview") or ""
        air_date = ep_details.get("air_date") or ""
        y = int(air_date[:4]) if len(air_date) >= 4 and air_date[:4].isdigit() else None

        poster_path = _download_tmdb_poster(media_path, poster_rel, f"tmdb_tv_{tv_id}")

        clean = f"{tv_details.get('name') or show_title} • S{season:02d}E{episode:02d}"
        if ep_name:
            clean += f" • {ep_name}"

        out = {
            "clean_title": clean,
            "year": y,
            "plot": ep_plot or None,
            "poster_path": poster_path or None,
        }
        return out

    # --- Otherwise: treat as movie ---
    query_title = local_meta.get("clean_title") or local_meta.get("title") or local_meta.get("fallback_title") or base
    year_hint = local_meta.get("year")

    params = {"query": query_title}
    if year_hint:
        params["year"] = year_hint

    search = _tmdb_get_json("/search/movie", params)
    best = _pick_best(search.get("results") or [], query_title, year_hint, "title", "release_date")
    if not best:
        return {}

    movie_id = best.get("id")
    if not movie_id:
        return {}

    details = _tmdb_get_json(f"/movie/{movie_id}", {})
    title = details.get("title") or best.get("title") or query_title
    overview = details.get("overview") or ""
    release_date = details.get("release_date") or best.get("release_date") or ""
    y = int(release_date[:4]) if len(release_date) >= 4 and release_date[:4].isdigit() else None

    poster_rel = details.get("poster_path") or best.get("poster_path") or ""
    poster_path = _download_tmdb_poster(media_path, poster_rel, f"tmdb_movie_{movie_id}")

    out = {
        "clean_title": title,
        "year": y,
        "plot": overview or None,
        "poster_path": poster_path or None,
    }

    # runtime fallback if ffprobe missing
    runtime = details.get("runtime")
    if runtime and not local_meta.get("duration_seconds"):
        out["duration_seconds"] = int(runtime) * 60

    return out


def extract_metadata(media_path: str, fallback_title: str) -> dict:
    """
    Unified extractor: local + TMDB enrichment.
    """
    local = extract_local_metadata(media_path, fallback_title)
    tmdb = tmdb_enrich(media_path, local)

    if not tmdb:
        return local

    # Merge: prefer TMDB fields, but don't nuke local values if TMDB returned nothing
    merged = dict(local)
    for k, v in tmdb.items():
        if v is None or v == "":
            continue
        merged[k] = v

    return merged
