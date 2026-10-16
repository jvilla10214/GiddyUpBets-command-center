"""Orchestrator: check @thenyra's streams tab for new full broadcasts, and
for each one, transcribe -> find Maggie's segments -> extract -> write to
the Stable Tour store. Meant to run unattended from GitHub Actions on a
schedule, but just as runnable by hand for testing — same shape as the
other two pipelines in this repo.
"""
import datetime
import json
import os
import shutil
import sys
import traceback

import config
import discover
import extract_interviews
import extract_quotes
import find_segments
import transcribe
import write_notes


def log(msg):
    print(msg, flush=True)


def load_dropped_quotes():
    if not os.path.exists(config.DROPPED_QUOTES_PATH):
        return []
    with open(config.DROPPED_QUOTES_PATH) as f:
        return json.load(f)


def save_dropped_quotes(dropped):
    os.makedirs(config.STATE_DIR, exist_ok=True)
    with open(config.DROPPED_QUOTES_PATH, "w") as f:
        json.dump(dropped, f, indent=2)


def record_dropped(dropped_list, video, reason, entry, error=None):
    key = f"{video['id']}|{entry.get('timestamp', '')}|{entry.get('horse', '')}"
    if any(d["key"] == key for d in dropped_list):
        return
    # Paddock entries carry "observation"; interview entries carry
    # "speaker"/"role"/"question"/"quote" instead — record whichever shape
    # this entry actually has rather than assuming one.
    content = entry.get("observation") or " ".join(
        filter(None, [entry.get("question"), entry.get("quote")])
    )
    dropped_list.append({
        "key": key,
        "reason": reason,
        "video": video["title"],
        "videoId": video["id"],
        "videoDate": video.get("upload_date", ""),
        "horse": entry.get("horse", ""),
        "speaker": entry.get("speaker", ""),
        "role": entry.get("role", ""),
        "content": content,
        "timestamp": entry.get("timestamp", ""),
        "error": error,
        "foundAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "reviewed": False,
    })


def run_pass(label, video, dropped_quotes, windows, extract_fn, write_fn):
    log(f"  {len(windows)} candidate {label} window(s)")
    if not windows:
        return {"entries": 0}

    result = extract_fn(windows)
    log(f"  extracting {label}: {len(result['entries'])} entries, {len(result['unparsed'])} unparsed")
    if not result["entries"]:
        return {"entries": 0}

    write_result = write_fn(video, result["entries"])
    log(
        f"    wrote {len(write_result['confirmed'])} confirmed, "
        f"{len(write_result['duplicates'])} already existed, "
        f"{len(write_result['skipped'])} skipped, "
        f"{len(write_result['missing'])} missing after verify, "
        f"{len(write_result['failed'])} failed"
    )
    for item in write_result["skipped"]:
        record_dropped(dropped_quotes, video, item["reason"], item["entry"])
    for item in write_result["missing"]:
        record_dropped(dropped_quotes, video, "lost_after_verify", item["entry"])
    for item in write_result["failed"]:
        record_dropped(dropped_quotes, video, "write_failed", item["entry"], error=item["error"])
    return {
        "entries": len(result["entries"]),
        "confirmed": len(write_result["confirmed"]),
        "duplicates": len(write_result["duplicates"]),
        "skipped": len(write_result["skipped"]),
        "missing": len(write_result["missing"]),
        "failed": len(write_result["failed"]),
        "unparsed": result["unparsed"],
    }


def process_broadcast(video, dropped_quotes):
    work_dir = os.path.join(config.TMP_DIR, video["id"])
    summary = {"video": video["title"], "id": video["id"]}

    try:
        video["upload_date"] = discover.get_upload_date(video["id"])

        log(f"  transcribing ({round(video.get('duration', 0) / 60, 1)} min)...")
        transcript = transcribe.transcribe_broadcast(video["id"], work_dir)
        log(f"  transcribed: {len(transcript['segments'])} segments")

        paddock_windows = find_segments.find_candidate_windows(transcript["stitched"])
        summary["paddock"] = run_pass(
            "Maggie paddock", video, dropped_quotes, paddock_windows,
            extract_quotes.extract_paddock_notes, write_notes.write_paddock_notes,
        )

        interview_windows = find_segments.find_interview_windows(transcript["stitched"])
        summary["interviews"] = run_pass(
            "interview", video, dropped_quotes, interview_windows,
            extract_interviews.extract_interviews, write_notes.write_interview_notes,
        )

        discover.mark_processed(video["id"])
        summary["status"] = "ok"
    except Exception as e:
        summary["status"] = "error"
        summary["error"] = f"{e}\n{traceback.format_exc()}"
        log(f"  ERROR: {e}")
        # Deliberately NOT marking as processed on error — a transient
        # failure (network blip, API 500, an actual Groq rate limit)
        # retries next run instead of silently dropping the broadcast.
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)

    return summary


def main():
    if not config.GROQ_API_KEY:
        log("GROQ_API_KEY not set — aborting.")
        sys.exit(1)
    if not config.ANTHROPIC_API_KEY:
        log("ANTHROPIC_API_KEY not set — aborting.")
        sys.exit(1)

    videos, first_run = discover.get_new_broadcasts()

    if first_run:
        log("First run: seeded state with the current streams listing, nothing transcribed. "
            "Future runs will only pick up genuinely new broadcasts.")
        return

    if not videos:
        log("No new broadcasts since last run.")
        return

    log(f"{len(videos)} new broadcast(s) to process:")
    dropped_quotes = load_dropped_quotes()
    all_summaries = []
    for v in videos:
        log(f"- {v['title']}")
        all_summaries.append(process_broadcast(v, dropped_quotes))
    save_dropped_quotes(dropped_quotes)

    os.makedirs(config.LOG_DIR, exist_ok=True)
    log_path = os.path.join(config.LOG_DIR, "last_run.json")
    with open(log_path, "w") as f:
        json.dump(all_summaries, f, indent=2)
    log(f"\nWrote run summary to {log_path}")


if __name__ == "__main__":
    main()
