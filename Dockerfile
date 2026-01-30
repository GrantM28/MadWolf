# --- Build a small, practical image ---
FROM python:3.12-slim

# ffmpeg is optional for MVP; installed now so you can add HLS transcoding later without redoing the base
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY server/requirements.txt /app/server/requirements.txt
RUN pip install --no-cache-dir -r /app/server/requirements.txt

COPY server /app/server
COPY web /app/web

ENV MADWOLF_CONFIG_DIR=/config
ENV MADWOLF_MEDIA_ROOT=/mnt/media
ENV MADWOLF_SECRET=change-me
ENV MADWOLF_PORT=8080

EXPOSE 8080

CMD ["python", "-m", "uvicorn", "server.app.main:app", "--host", "0.0.0.0", "--port", "8080"]
