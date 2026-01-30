import os
import re
import json
import subprocess
from xml.etree import ElementTree as ET

DROP = {
    "1080p","2160p","720p","480p","4k","hdr","dv","dolby","vision","atmos",
    "webrip","web-dl","webdl","bluray","bdrip","brip","dvdrip","hdrip",
    "x264","x265","h264","h265","hevc","avc",
    "aac","ac3","dts","truehd","eac3","flac","mp3",
    "yify","yts","rarbg","etrg","evo",
    "proper","repack","remux","extended","unrated","limited","complete",
}

ART_NAMES = [
    "poster.jpg","poster.png",
    "folder.jpg","folder.png",
    "cover.jpg","cover.png",
    "movie.jpg","movie.png",
]

def clean_title_year(filename_no_ext: str) -> tuple[str, int | None]:
    s = filename_no_ext.replace(".", " ").replace("_", " ")
    # remove [bracket groups]
    s = re.sub(r"\[[^\]]*\]", " ", s)

    # find year
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

def find_nfo(media_path: str) -> str | None:
    d = os.path.dirname(media_path)
    base = os.path.splitext(os.path.basename(media_path))[0]
    direct = os.path.join(d, f"{base}.nfo")
    if os.path.isfile(direct):
        return direct
    # fallback: first .nfo in folder
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

    # If it doesn't look like XML, skip
    if "<" not in txt or ">" not in txt:
        return {}

    try:
        root = ET.fromstring(txt)
    except ET.ParseError:
        return {}

    # Typical Kodi structure is <movie>...</movie>
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

    for fn in ART_NAMES:
        p = os.path.join(d, fn)
        if os.path.isfile(p):
            return p

    # sometimes art is in parent dir for single-file movies
    parent = os.path.dirname(d)
    for fn in ART_NAMES:
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

    # duration
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
