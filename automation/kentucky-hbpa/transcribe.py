"""Download a video's audio via yt-dlp and transcribe it via Groq's Whisper
API. These clips run 2-15 minutes (single-digit-MB audio), so a single
request is normally enough — chunking only kicks in if a clip is long enough
to exceed Groq's ~25MB per-request limit, same ffmpeg-stream-copy approach as
automation/podcast-quotes/transcribe.py.
"""
import json
import os
import re
import subprocess

import requests

import config


def _run(cmd, timeout=180):
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    if result.returncode != 0:
        raise RuntimeError(f"Command failed: {' '.join(cmd)}\n{result.stderr[-2000:]}")
    return result.stdout


def download_audio(video_id, work_dir):
    os.makedirs(work_dir, exist_ok=True)
    out_template = os.path.join(work_dir, "audio.%(ext)s")
    _run([
        config.YTDLP_BIN,
        "--socket-timeout", "20",
        *config.ytdlp_auth_args(),
        "-f", "bestaudio",
        "-x", "--audio-format", "m4a",
        "-o", out_template,
        f"https://www.youtube.com/watch?v={video_id}",
    ], timeout=300)
    path = os.path.join(work_dir, "audio.m4a")
    if not os.path.exists(path):
        raise RuntimeError(f"Expected audio file not found after download: {path}")
    return path


def probe_duration_seconds(path):
    result = subprocess.run(
        [config.FFMPEG_BIN, "-i", path], capture_output=True, text=True
    )
    m = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", result.stderr)
    if not m:
        raise RuntimeError(f"Could not parse duration from ffmpeg output for {path}")
    h, mnt, s = m.groups()
    return int(h) * 3600 + int(mnt) * 60 + float(s)


def split_audio(path, out_dir, target_chunk_bytes=config.GROQ_MAX_CHUNK_BYTES):
    os.makedirs(out_dir, exist_ok=True)
    size_bytes = os.path.getsize(path)
    duration_s = probe_duration_seconds(path)
    bytes_per_second = size_bytes / duration_s
    chunk_seconds = max(60, int((target_chunk_bytes / bytes_per_second) * 0.85))

    pattern = os.path.join(out_dir, "chunk_%03d.m4a")
    _run([
        config.FFMPEG_BIN, "-i", path, "-f", "segment",
        "-segment_time", str(chunk_seconds), "-c", "copy", pattern,
    ], timeout=300)
    return sorted(
        os.path.join(out_dir, f) for f in os.listdir(out_dir) if f.startswith("chunk_")
    )


def transcribe_chunk(chunk_path):
    with open(chunk_path, "rb") as f:
        data = {"model": config.GROQ_MODEL, "response_format": "verbose_json"}
        headers = {"Authorization": f"Bearer {config.GROQ_API_KEY}"}
        files = {"file": (os.path.basename(chunk_path), f, "audio/m4a")}
        r = requests.post(
            config.GROQ_TRANSCRIBE_URL, headers=headers, data=data, files=files, timeout=300
        )
    r.raise_for_status()
    return r.json()


def transcribe_video(video_id, work_dir):
    audio_path = download_audio(video_id, work_dir)
    size_bytes = os.path.getsize(audio_path)

    if size_bytes <= config.GROQ_MAX_CHUNK_BYTES:
        chunks = [audio_path]
    else:
        chunks = split_audio(audio_path, os.path.join(work_dir, "chunks"))

    full_text_parts = []
    all_segments = []
    offset = 0.0
    for chunk_path in chunks:
        result = transcribe_chunk(chunk_path)
        for seg in result.get("segments", []):
            all_segments.append({
                "start": seg["start"] + offset,
                "end": seg["end"] + offset,
                "text": seg["text"],
            })
        full_text_parts.append(result.get("text", ""))
        offset += probe_duration_seconds(chunk_path)

    return {"text": " ".join(full_text_parts).strip(), "segments": all_segments}


if __name__ == "__main__":
    import sys

    if len(sys.argv) < 2:
        print("usage: transcribe.py <youtube_video_id>")
        sys.exit(1)
    video_id = sys.argv[1]
    work_dir = os.path.join(config.TMP_DIR, video_id)
    transcript = transcribe_video(video_id, work_dir)
    print(f"{len(transcript['segments'])} segments")
    print(transcript["text"][:2000])
