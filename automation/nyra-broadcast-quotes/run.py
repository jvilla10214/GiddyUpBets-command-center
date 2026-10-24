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

import requests

import config
import discover
import extract_interviews
import extract_quotes
import find_segments
import transcribe
import write_notes

# Matches a key in the Worker's WATCHED_PIPELINES (see /pipeline-health-
# warnings in workers/stable-tour-feed.js) — the dashboard's stale-pipeline
# warning is keyed off this exact string.
PIPELINE_JOB_NAME = "nyra-broadcast-quotes"


def log(msg):
    print(msg, flush=True)


def report_pipeline_status(ok, summary=None, error=None):
    """Best-effort self-report into the Worker's shared pipeline:lastrun:/
    pipeline:lastsuccess: KV namespace (see recordPipelineRun() and the new
    /pipeline-report route in workers/stable-tour-feed.js) — this pipeline
    runs outside the Worker, as its own GitHub Actions process, so it can't
    call recordPipelineRun() directly the way the Worker's own cron jobs do.
    Built 2026-10-19 after a ~19-hour YOUTUBE_COOKIES outage went unnoticed
    across both YouTube pipelines. Never raises — a reporting failure
    shouldn't break the actual run."""
    try:
        requests.post(
            f"{config.WORKER_BASE}/pipeline-report",
            json={"job": PIPELINE_JOB_NAME, "ok": ok, "summary": summary, "error": error},
            timeout=15,
        )
    except Exception as e:
        log(f"  (pipeline-report failed, non-fatal: {e})")


def load_dropped_quotes():
    if not os.path.exists(config.DROPPED_QUOTES_PATH):
        return []
    with open(config.DROPPED_QUOTES_PATH) as f:
        return json.load(f)


def save_dropped_quotes(dropped):
    os.makedirs(config.STATE_DIR, exist_ok=True)
    with open(config.DROPPED_QUOTES_PATH, "w") as f:
        json.dump(dropped, f, indent=2)


def record_unparsed(dropped_list, video, label, lines):
    """A line Claude returned that didn't match BULLET_RE has no
    timestamp/horse to key on (unlike record_dropped's entries), so it's
    keyed by position in this run's unparsed list instead. Without this, a
    real parse-format failure (e.g. the 2026-10-17 run: 13/13 lines unparsed)
    only ever showed up as a count in ephemeral GitHub Actions logs — never
    the actual text — making it unrecoverable after the fact."""
    for i, line in enumerate(lines):
        key = f"{video['id']}|unparsed|{label}|{i}"
        if any(d["key"] == key for d in dropped_list):
            continue
        dropped_list.append({
            "key": key,
            "reason": "unparsed_extraction",
            "video": video["title"],
            "videoId": video["id"],
            "videoDate": video.get("upload_date", ""),
            "horse": "",
            "speaker": "",
            "role": "",
            "content": line,
            "timestamp": "",
            "error": None,
            "foundAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "reviewed": False,
        })


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
    if result["unparsed"]:
        record_unparsed(dropped_quotes, video, label, result["unparsed"])
    if not result["entries"]:
        return {"entries": 0, "unparsed": result["unparsed"]}

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
        transcript = transcribe.get_transcript(video["id"], work_dir)
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
        report_pipeline_status(True, summary="first run: seeded state")
        return

    if not videos:
        log("No new broadcasts since last run.")
        report_pipeline_status(True, summary="no new broadcasts")
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

    # A run only counts as a real failure for the dashboard warning when
    # EVERY broadcast in it errored out (the bot-wall pattern — see
    # report_pipeline_status's own comment) — one broadcast failing while
    # others succeed means the infrastructure is fine, nothing to warn
    # about.
    errored = [s for s in all_summaries if s.get("status") == "error"]
    if errored and len(errored) == len(all_summaries):
        raw_error = errored[0].get("error", "unknown error")
        # The raw error is a Python traceback with a full yt-dlp command
        # embedded — accurate for debugging but unreadable on the dashboard.
        # When it's clearly the bot wall, say that plainly instead; anything
        # else still shows the raw text so a genuinely new failure mode
        # isn't hidden behind a wrong label.
        if transcribe.YOUTUBE_BOT_WALL_RE.search(raw_error):
            clean_error = "YouTube blocked the download — check the runner / cookies."
        else:
            clean_error = raw_error[:500]
        report_pipeline_status(False, error=clean_error)
        # report_pipeline_status() only posts a warning to the Worker — it
        # doesn't affect this process's own exit code. Without this, a run
        # where every single broadcast failed (e.g. YouTube's bot wall)
        # still exits 0, so GitHub Actions marks it green. Confirmed real:
        # every run since 2026-10-20 showed "success" despite transcribing
        # nothing, which is exactly what let that outage run unnoticed.
        sys.exit(1)
    else:
        report_pipeline_status(True, summary={"processed": len(all_summaries), "errored": len(errored)})


if __name__ == "__main__":
    main()
