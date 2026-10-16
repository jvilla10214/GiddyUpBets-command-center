"""List the Kentucky HBPA channel's videos and track which ones have already
been processed, so a scheduled run only picks up genuinely new uploads.

Unlike the Steve Byk podcast pipeline (automation/podcast-quotes/), there is
NO title-based trainer filter here. Two reasons:

1. This channel is already narrowly scoped to graded-stakes/Triple-Crown-
   trail/Breeders' Cup-prep horses at Kentucky tracks — a handful of videos
   per race day, not a firehose of unrelated content (confirmed: ~2-4
   uploads on a typical race day, nothing like the Byk feed's 350+ broad
   industry round-tables). A title filter solved a real noise problem there
   that doesn't exist here.
2. A trainer-name title filter would actively fight the current standing
   policy (project_auto_track_trainers_shipped_2026-10-11): every quote gets
   auto-tracked now, including from a trainer/jockey never seen before, with
   a weekly manual audit as the safety net instead of upfront gatekeeping.
   Filtering on "already-tracked trainer" here would silently drop exactly
   the new-trainer case that policy exists to catch.

So every new video ID gets queued; extract_quotes.py decides per-speaker
whether there's anything worth filing (trainer/jockey quote about a named
horse) or nothing to do (owner/agent commentary, no clear horse, etc.).
"""
import json
import os
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


def fetch_channel_videos(playlist_end=30):
    """Returns recent videos, newest first, as {id, title, duration}."""
    cmd = [
        config.YTDLP_BIN,
        "--socket-timeout", "20",
        "--flat-playlist",
        "--playlist-end", str(playlist_end),
        "-j",
        config.CHANNEL_VIDEOS_URL,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=90)
    if result.returncode != 0:
        raise RuntimeError(f"yt-dlp channel listing failed: {result.stderr[-2000:]}")
    videos = []
    for line in result.stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        d = json.loads(line)
        videos.append({
            "id": d.get("id"),
            "title": (d.get("title") or "").strip(),
            "duration": d.get("duration") or 0,
        })
    return videos


def get_new_videos():
    """Returns (videos_to_process, is_first_run).

    On the very first run (no state file yet), every video currently listed
    is marked as seen WITHOUT being queued — same "don't backfill the whole
    channel on day one" guard as the Byk pipeline's first-run seeding.
    """
    processed = load_json(config.PROCESSED_VIDEO_IDS_PATH, {"ids": []})
    seen = set(processed["ids"])
    is_first_run = len(seen) == 0

    videos = fetch_channel_videos()

    if is_first_run:
        save_json(config.PROCESSED_VIDEO_IDS_PATH, {"ids": [v["id"] for v in videos]})
        return [], True

    return [v for v in videos if v["id"] not in seen], False


def get_upload_date(video_id):
    """flat-playlist (used above for the fast channel listing) doesn't carry
    upload_date — fetching real per-video metadata for every video on the
    channel just to get a date would be slow, so this is called once per
    genuinely-new video instead, right before it's processed. Returns
    YYYY-MM-DD (this store's standard date format) or "" if unavailable."""
    cmd = [
        config.YTDLP_BIN,
        "--socket-timeout", "20",
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
    videos, first_run = get_new_videos()
    if first_run:
        print("First run: seeded state with the current channel listing, nothing processed. "
              "Future runs will only pick up genuinely new uploads.")
    else:
        print(f"{len(videos)} new video(s) found:")
        for v in videos:
            print(f"  - {v['title']}  ({round(v['duration']/60, 1)} min)  [{v['id']}]")
