import os
import mimetypes
from fastapi import Request, HTTPException
from fastapi.responses import StreamingResponse, Response

CHUNK_SIZE = 1024 * 1024  # 1MB

def _file_iter(path: str, start: int, end: int):
    with open(path, "rb") as f:
        f.seek(start)
        remaining = end - start + 1
        while remaining > 0:
            chunk = f.read(min(CHUNK_SIZE, remaining))
            if not chunk:
                break
            remaining -= len(chunk)
            yield chunk

def serve_file_with_range(request: Request, path: str) -> Response:
    if not os.path.isfile(path):
        raise HTTPException(status_code=404, detail="file_not_found")

    file_size = os.path.getsize(path)
    ctype, _ = mimetypes.guess_type(path)
    ctype = ctype or "application/octet-stream"

    range_header = request.headers.get("range")
    if not range_header:
        # Full file
        headers = {
            "Accept-Ranges": "bytes",
            "Content-Length": str(file_size),
        }
        return StreamingResponse(_file_iter(path, 0, file_size - 1), media_type=ctype, headers=headers)

    # Example: "bytes=0-"
    try:
        units, rng = range_header.split("=")
        if units.strip() != "bytes":
            raise ValueError
        start_s, end_s = rng.split("-")
        start = int(start_s) if start_s else 0
        end = int(end_s) if end_s else file_size - 1
        end = min(end, file_size - 1)
        if start > end:
            raise ValueError
    except ValueError:
        raise HTTPException(status_code=416, detail="invalid_range")

    headers = {
        "Content-Range": f"bytes {start}-{end}/{file_size}",
        "Accept-Ranges": "bytes",
        "Content-Length": str(end - start + 1),
    }
    return StreamingResponse(
        _file_iter(path, start, end),
        status_code=206,
        media_type=ctype,
        headers=headers,
    )
