"""Download a full NYRA broadcast's audio via yt-dlp and transcribe it via
Groq's Whisper API. These run 4.5-6 hours, always well over Groq's ~25MB
per-request limit, so this always chunks — same ffmpeg stream-copy approach
as automation/podcast-quotes/transcribe.py (the other long-form pipeline in
this repo), byte-rate-estimated chunk sizing rather than a fixed duration so
a chunk reliably lands under the limit regardless of the file's bitrate.
"""
import json
import os
import re
import subprocess

import requests

import config


def _run(cmd, timeout=600):
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
    ], timeout=3600)
    path = os.path.join(work_dir, "audio.m4a")
    if not os.path.exists(path):
        raise RuntimeError(f"Expected audio file not found after download: {path}")
    return path


def probe_duration_seconds(path):
    result = subprocess.run([config.FFMPEG_BIN, "-i", path], capture_output=True, text=True)
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
    # Leave real headroom — ffmpeg's segment muxer doesn't cut exactly on
    # request, and per-container overhead varies a little chunk to chunk.
    chunk_seconds = max(60, int((target_chunk_bytes / bytes_per_second) * 0.85))

    pattern = os.path.join(out_dir, "chunk_%03d.m4a")
    _run([
        config.FFMPEG_BIN, "-i", path, "-f", "segment",
        "-segment_time", str(chunk_seconds), "-c", "copy", pattern,
    ], timeout=600)
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


def format_ts(seconds):
    h, rem = divmod(int(seconds), 3600)
    m, s = divmod(rem, 60)
    return f"{h:02d}:{m:02d}:{s:02d}"


# Matches YouTube's own inline annotations ("[music]", "[Applause]", ...)
# that its auto-captioner sometimes inserts mid-sentence — confirmed real in
# a sample caption pull 2026-10-19 ("The world's premier breeding [music]
# stock event..."). Left in, a cue phrase split across one of these (e.g.
# "how did that [music] feel") would silently fail to match
# find_segments.py's cue regexes, which expect the words contiguous.
INLINE_CAPTION_ANNOTATION_RE = re.compile(r"\[\w+\]")

# yt-dlp's own wording for YouTube's bot-wall ("Sign in to confirm you're
# not a bot") — confirmed real on GitHub's shared runner IPs since
# 2026-10-20. Checked for explicitly so a walled run says so plainly instead
# of being misreported as "no captions available for this broadcast", which
# looks identical to a genuinely caption-less upload and hid this outage
# for days.
YOUTUBE_BOT_WALL_RE = re.compile(r"sign in to confirm you'?re not a bot", re.IGNORECASE)


def _parse_json3_captions(path):
    """Converts YouTube's own auto-caption json3 format into the same
    {start, end, text} segment shape transcribe_chunk()'s Whisper output
    produces. `aAppend` events are just newline joiners between caption
    lines, not real content — skipped, not transcribed text."""
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    segments = []
    stitched_lines = []
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
        stitched_lines.append(f"[{format_ts(start)}] {text}")
    return {
        "text": " ".join(s["text"] for s in segments),
        "segments": segments,
        "stitched": "\n".join(stitched_lines),
    }


def fetch_captions_transcript(video_id, work_dir):
    """Tries YouTube's own auto-generated captions before resorting to a
    full audio download + Whisper transcription — a single ~1-second
    metadata-style request instead of initiating a full media stream
    download, which is specifically what triggers YouTube's "confirm you're
    not a bot" wall (confirmed real 2026-10-19: a plain, cookie-less caption
    fetch succeeded from a sandbox where every audio download for the same
    channel's videos got walled). "en-orig" is the real original-language
    auto-caption track; "en" is tried as a fallback for a video that only
    exposes that label. Returns None (caller falls back to
    transcribe_broadcast()) when neither is available for this video —
    older or unusual uploads sometimes have no auto-caption track at all."""
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
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        caption_path = f"{out_template}.{lang}.json3"
        if result.returncode == 0 and os.path.exists(caption_path):
            parsed = _parse_json3_captions(caption_path)
            if parsed["segments"]:
                return parsed
        elif result.returncode != 0:
            last_stderr = result.stderr
    # Neither language worked — surface WHY instead of leaving the caller to
    # assume this broadcast just has no caption track. A walled attempt and
    # a genuinely caption-less upload look identical from the caller's side
    # otherwise, which is exactly what hid the 2026-10-20 bot-wall outage:
    # every run logged "no captions available" and kept reporting success.
    if last_stderr:
        if YOUTUBE_BOT_WALL_RE.search(last_stderr):
            print("  captions fetch blocked: YouTube's bot wall (\"Sign in to confirm you're "
                  "not a bot\") — this runner's IP is walled, not a caption-less broadcast.", flush=True)
        else:
            print(f"  captions fetch failed (not the bot wall): {last_stderr.strip()[-500:]}", flush=True)
    return None


def get_transcript(video_id, work_dir):
    """Prefer YouTube's own captions (fetch_captions_transcript) over the
    full audio-download + Whisper path — see that function's own comment
    for why. Falls back to transcribe_broadcast() whenever no caption track
    exists, so a video without one is no worse off than before this
    existed."""
    captions = fetch_captions_transcript(video_id, work_dir)
    if captions is not None:
        print(f"  using YouTube captions ({len(captions['segments'])} segments) — no audio download needed", flush=True)
        return captions
    print("  no YouTube captions available — falling back to audio download + Whisper", flush=True)
    return transcribe_broadcast(video_id, work_dir)


def transcribe_broadcast(video_id, work_dir):
    """Returns {text, segments, stitched} — `stitched` is the
    "[HH:MM:SS] text" format the segment-finder greps, same convention the
    original manual process used."""
    audio_path = download_audio(video_id, work_dir)
    chunks = split_audio(audio_path, os.path.join(work_dir, "chunks"))

    full_text_parts = []
    all_segments = []
    stitched_lines = []
    offset = 0.0
    for i, chunk_path in enumerate(chunks):
        result = transcribe_chunk(chunk_path)
        for seg in result.get("segments", []):
            start = seg["start"] + offset
            all_segments.append({"start": start, "end": seg["end"] + offset, "text": seg["text"]})
            stitched_lines.append(f"[{format_ts(start)}] {seg['text'].strip()}")
        full_text_parts.append(result.get("text", ""))
        offset += probe_duration_seconds(chunk_path)

    return {
        "text": " ".join(full_text_parts).strip(),
        "segments": all_segments,
        "stitched": "\n".join(stitched_lines),
    }


if __name__ == "__main__":
    import sys

    if len(sys.argv) < 2:
        print("usage: transcribe.py <youtube_video_id>")
        sys.exit(1)
    video_id = sys.argv[1]
    work_dir = os.path.join(config.TMP_DIR, video_id)
    transcript = transcribe_broadcast(video_id, work_dir)
    print(f"{len(transcript['segments'])} segments")
    print(transcript["stitched"][:2000])
