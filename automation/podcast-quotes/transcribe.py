"""Download an episode's audio and transcribe it via Groq's Whisper API.

Episodes run 50-115MB+ as mp3, well over Groq's ~25MB per-request limit, so
this splits the audio into time-based chunks with ffmpeg (stream-copied, no
re-encoding — fast and lossless) sized to stay under that limit, transcribes
each chunk with response_format=verbose_json (per-segment timestamps), then
stitches everything back into one absolute-timestamped transcript.
"""
import json
import os
import re
import subprocess
import time

import requests

import config


def _run(cmd):
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"Command failed: {' '.join(cmd)}\n{result.stderr}")
    return result.stdout


def download_audio(url, dest_path):
    r = requests.get(url, headers={"User-Agent": config.USER_AGENT}, stream=True, timeout=120)
    r.raise_for_status()
    with open(dest_path, "wb") as f:
        for chunk in r.iter_content(chunk_size=1 << 20):
            f.write(chunk)
    return dest_path


def probe_duration_seconds(path):
    """No ffprobe dependency — ffmpeg itself prints 'Duration: HH:MM:SS.xx'
    to stderr for any input, even without -show_entries, so a single ffmpeg
    binary is enough (matters for the pip-installed static binary used in
    local testing, which doesn't bundle ffprobe separately)."""
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
    # Leave real headroom — ffmpeg's segment muxer doesn't cut exactly on
    # request, and per-container overhead varies a little chunk to chunk.
    chunk_seconds = max(60, int((target_chunk_bytes / bytes_per_second) * 0.85))

    pattern = os.path.join(out_dir, "chunk_%03d.mp3")
    _run([
        config.FFMPEG_BIN, "-y", "-i", path, "-f", "segment",
        "-segment_time", str(chunk_seconds), "-c", "copy", "-reset_timestamps", "1",
        pattern,
    ])

    chunks = sorted(
        f for f in os.listdir(out_dir) if f.startswith("chunk_") and f.endswith(".mp3")
    )
    # Each chunk's real start offset in the original episode, computed from
    # requested chunk_seconds — reset_timestamps makes each chunk file itself
    # start at t=0, so we track the offset ourselves for stitching later.
    return [
        {"path": os.path.join(out_dir, name), "start_offset": i * chunk_seconds}
        for i, name in enumerate(chunks)
    ]


def transcribe_chunk(chunk_path, prompt_hint=""):
    with open(chunk_path, "rb") as f:
        files = {"file": (os.path.basename(chunk_path), f, "audio/mpeg")}
        data = {
            "model": config.GROQ_MODEL,
            "response_format": "verbose_json",
            "language": "en",
        }
        if prompt_hint:
            data["prompt"] = prompt_hint
        headers = {"Authorization": f"Bearer {config.GROQ_API_KEY}"}
        for attempt in range(3):
            r = requests.post(
                config.GROQ_TRANSCRIBE_URL, headers=headers, data=data, files=files, timeout=300
            )
            if r.status_code == 200:
                return r.json()
            if r.status_code in (429, 500, 502, 503) and attempt < 2:
                time.sleep(5 * (attempt + 1))
                f.seek(0)
                continue
            r.raise_for_status()


def format_timestamp(seconds):
    m, s = divmod(int(seconds), 60)
    h, m = divmod(m, 60)
    return f"{h:02d}:{m:02d}:{s:02d}"


def transcribe_episode(audio_url, work_dir, guest_names=None):
    """Returns {"segments": [...], "text": "<plain text with periodic timestamp markers>"}"""
    os.makedirs(work_dir, exist_ok=True)
    audio_path = os.path.join(work_dir, "episode.mp3")
    download_audio(audio_url, audio_path)

    chunks_dir = os.path.join(work_dir, "chunks")
    chunks = split_audio(audio_path, chunks_dir)

    prompt_hint = ""
    if guest_names:
        prompt_hint = "Horse racing interview. Guests: " + ", ".join(guest_names)

    all_segments = []
    for chunk in chunks:
        result = transcribe_chunk(chunk["path"], prompt_hint=prompt_hint)
        for seg in result.get("segments", []):
            all_segments.append(
                {
                    "start": seg["start"] + chunk["start_offset"],
                    "end": seg["end"] + chunk["start_offset"],
                    "text": seg["text"].strip(),
                }
            )

    all_segments.sort(key=lambda s: s["start"])

    lines = []
    last_marker_minute = -1
    for seg in all_segments:
        minute = int(seg["start"] // 60)
        if minute != last_marker_minute:
            lines.append(f"[{format_timestamp(seg['start'])}]")
            last_marker_minute = minute
        lines.append(seg["text"])

    return {"segments": all_segments, "text": "\n".join(lines)}


if __name__ == "__main__":
    import sys

    if len(sys.argv) < 2:
        print("usage: transcribe.py <audio_url> [work_dir]")
        sys.exit(1)
    work_dir = sys.argv[2] if len(sys.argv) > 2 else os.path.join(config.TMP_DIR, "test_episode")
    out = transcribe_episode(sys.argv[1], work_dir)
    transcript_path = os.path.join(work_dir, "transcript.json")
    with open(transcript_path, "w") as f:
        json.dump(out, f, indent=2)
    print(f"wrote {transcript_path} — {len(out['segments'])} segments")
    print(out["text"][:1000])
