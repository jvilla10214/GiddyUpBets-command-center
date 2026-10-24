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


# Matches YouTube's own inline annotations ("[music]", "[Applause]", ...)
# that its auto-captioner sometimes inserts mid-sentence — see the identical
# constant and reasoning in automation/nyra-broadcast-quotes/transcribe.py.
INLINE_CAPTION_ANNOTATION_RE = re.compile(r"\[\w+\]")

# yt-dlp's own wording for YouTube's bot-wall ("Sign in to confirm you're
# not a bot") — confirmed real on GitHub's shared runner IPs since
# 2026-10-20. Checked for explicitly so a walled run says so plainly instead
# of being misreported as "no captions available for this video", which
# looks identical to a genuinely caption-less upload and hid this outage
# for days.
YOUTUBE_BOT_WALL_RE = re.compile(r"sign in to confirm you'?re not a bot", re.IGNORECASE)


def _parse_json3_captions(path):
    """Converts YouTube's own auto-caption json3 format into the same
    {start, end, text} segment shape transcribe_chunk()'s Whisper output
    produces, so get_transcript() can hand either one to extract_quotes.py
    unchanged."""
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    segments = []
    for event in data.get("events", []):
        if event.get("aAppend") or "segs" not in event:
            continue
        text = "".join(seg.get("utf8", "") for seg in event["segs"])
        text = INLINE_CAPTION_ANNOTATION_RE.sub("", text).strip()
        if not text:
            continue
        start = event.get("tStartMs", 0) / 1000
        end = start + event.get("dDurationMs", 0) / 1000
        segments.append({"start": start, "end": end, "text": text})
    return {"text": " ".join(s["text"] for s in segments), "segments": segments}


def fetch_captions_transcript(video_id, work_dir):
    """Tries YouTube's own auto-generated captions before falling back to
    audio download + Whisper — a single ~1-second metadata-style request
    instead of a full media stream download, which is specifically what
    triggers YouTube's "confirm you're not a bot" wall (same real finding
    as automation/nyra-broadcast-quotes/transcribe.py; confirmed 2026-10-20
    that this channel's recent clips all carry a real en-orig auto-caption
    track too). Returns None (caller falls back to transcribe_video()) when
    neither "en-orig" nor "en" is available for this video."""
    os.makedirs(work_dir, exist_ok=True)
    out_template = os.path.join(work_dir, "captions")
    last_stderr = ""
    for lang in ("en-orig", "en"):
        cmd = [
            config.YTDLP_BIN,
            "--socket-timeout", "20",
            *config.ytdlp_auth_args(),
            "--skip-download",
            "--write-auto-sub",
            "--sub-lang", lang,
            "--sub-format", "json3",
            "-o", out_template,
            f"https://www.youtube.com/watch?v={video_id}",
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        caption_path = f"{out_template}.{lang}.json3"
        if result.returncode == 0 and os.path.exists(caption_path):
            parsed = _parse_json3_captions(caption_path)
            if parsed["segments"]:
                return parsed
        elif result.returncode != 0:
            last_stderr = result.stderr
    # Neither language worked — surface WHY instead of leaving the caller to
    # assume this video just has no caption track. A walled attempt and a
    # genuinely caption-less video look identical from the caller's side
    # otherwise, which is exactly what hid the 2026-10-20 bot-wall outage:
    # every run logged "no captions available" and kept reporting success.
    if last_stderr:
        if YOUTUBE_BOT_WALL_RE.search(last_stderr):
            print("  captions fetch blocked: YouTube's bot wall (\"Sign in to confirm you're "
                  "not a bot\") — this runner's IP is walled, not a caption-less video.", flush=True)
        else:
            print(f"  captions fetch failed (not the bot wall): {last_stderr.strip()[-500:]}", flush=True)
    return None


def get_transcript(video_id, work_dir):
    """Prefer YouTube's own captions over the full audio-download + Whisper
    path — see fetch_captions_transcript()'s own comment for why. Falls back
    to transcribe_video() whenever no caption track exists, so a video
    without one is no worse off than before this existed."""
    captions = fetch_captions_transcript(video_id, work_dir)
    if captions is not None:
        print(f"  using YouTube captions ({len(captions['segments'])} segments) — no audio download needed", flush=True)
        return captions
    print("  no YouTube captions available — falling back to audio download + Whisper", flush=True)
    return transcribe_video(video_id, work_dir)


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
