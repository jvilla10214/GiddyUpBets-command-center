"""List the @thenyra channel's "streams" tab for new full-broadcast uploads
and track which ones have already been processed.

Filters to titles starting with "America's Day at the Races" — the same tab
also carries a daily "Talking Horses" show, a separate program not in scope
here.
"""
import json
import os
import re
import subprocess

import config


def load_json(path, default):
    if not os.path.exists(path):
        return default
    with open(path) as f:
        return json.load(f)


def save_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)


# Was 20 — confirmed real 2026-10-19 that this let 3 real broadcasts (Sept
# 30, Oct 1-2) scroll out of the raw (pre-title-filter) window and never get
# queued at all, with no trace left behind (not even a "seen on first run"
# skip, since by the time anyone noticed they'd simply fallen off a window
# that moves forward with every new "Talking Horses" or other non-matching
# upload interspersed on the same tab). 40 gives real margin against a gap
# like that recurring.
def fetch_streams(playlist_end=40):
    cmd = [
        config.YTDLP_BIN,
        "--socket-timeout", "20",
        *config.ytdlp_auth_args(),
        "--flat-playlist",
        "--playlist-end", str(playlist_end),
        "-j",
        config.CHANNEL_STREAMS_URL,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=90)
    if result.returncode != 0:
        raise RuntimeError(f"yt-dlp streams listing failed: {result.stderr[-2000:]}")
    videos = []
    for line in result.stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        d = json.loads(line)
        title = (d.get("title") or "").strip()
        if not title.startswith(config.TITLE_PREFIX):
            continue
        duration = d.get("duration") or 0
        # A still-airing or just-posted stream can list with duration 0
        # before YouTube finishes processing the VOD — skip it this run, it
        # picks up normally once that settles (confirmed real: today's own
        # stream showed this while still live during testing).
        if duration == 0:
            continue
        videos.append({"id": d.get("id"), "title": title, "duration": duration})
    return videos


def get_new_broadcasts():
    """Returns (videos_to_process, is_first_run). First run seeds state
    without processing anything — same "don't backfill history" guard as
    the other two pipelines in this repo."""
    processed = load_json(config.PROCESSED_VIDEO_IDS_PATH, {"ids": []})
    seen = set(processed["ids"])
    is_first_run = len(seen) == 0

    videos = fetch_streams()

    if is_first_run:
        save_json(config.PROCESSED_VIDEO_IDS_PATH, {"ids": [v["id"] for v in videos]})
        return [], True

    return [v for v in videos if v["id"] not in seen], False


def get_upload_date(video_id):
    cmd = [
        config.YTDLP_BIN,
        "--socket-timeout", "20",
        *config.ytdlp_auth_args(),
        "--print", "%(upload_date)s",
        f"https://www.youtube.com/watch?v={video_id}",
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    raw = result.stdout.strip()
    if result.returncode != 0 or len(raw) != 8 or not raw.isdigit():
        return ""
    return f"{raw[0:4]}-{raw[4:6]}-{raw[6:8]}"


def mark_processed(video_id):
    processed = load_json(config.PROCESSED_VIDEO_IDS_PATH, {"ids": []})
    if video_id not in processed["ids"]:
        processed["ids"].append(video_id)
        save_json(config.PROCESSED_VIDEO_IDS_PATH, processed)


if __name__ == "__main__":
    videos, first_run = get_new_broadcasts()
    if first_run:
        print("First run: seeded state with the current streams listing, nothing processed. "
              "Future runs will only pick up genuinely new broadcasts.")
    else:
        print(f"{len(videos)} new broadcast(s) found:")
        for v in videos:
            print(f"  - {v['title']}  ({round(v['duration']/60, 1)} min)  [{v['id']}]")
