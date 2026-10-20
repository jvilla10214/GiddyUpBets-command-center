"""Orchestrator: check the Kentucky HBPA YouTube channel for new videos, and
for each one, transcribe -> extract -> write to the Stable Tour store. Meant
to run unattended from GitHub Actions on a schedule, but just as runnable by
hand for testing — same shape as automation/podcast-quotes/run.py.

No email step here on purpose — extracted quotes land in the same shared
Stable Tour database the existing morning entry-alert emails already pull
from, so they show up there automatically without a separate notification.
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
import extract_quotes
import transcribe
import write_notes

# Matches a key in the Worker's WATCHED_PIPELINES (see /pipeline-health-
# warnings in workers/stable-tour-feed.js) — the dashboard's stale-pipeline
# warning is keyed off this exact string.
PIPELINE_JOB_NAME = "kentucky-hbpa"


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


def record_dropped(dropped_list, video, reason, entry, error=None):
    """Append-only record of a quote the pipeline found but didn't file —
    no clear horse/speaker, a non-trainer/jockey role (owner, agent,
    broadcaster — real content, just nowhere to go in the current note
    schema), lost to the KV write race even after retries, or a hard API
    failure. Deduped by (video id, timestamp, horse) so re-running the same
    video doesn't pile up repeat entries for the same dropped quote."""
    key = f"{video['id']}|{entry.get('timestamp', '')}|{entry.get('horse', '')}"
    if any(d["key"] == key for d in dropped_list):
        return
    dropped_list.append({
        "key": key,
        "reason": reason,
        "video": video["title"],
        "videoId": video["id"],
        "videoDate": video.get("upload_date", ""),
        "speaker": entry.get("speaker", ""),
        "role": entry.get("role", ""),
        "horse": entry.get("horse", ""),
        "quote": entry.get("quote", ""),
        "question": entry.get("question", ""),
        "timestamp": entry.get("timestamp", ""),
        "error": error,
        "foundAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "reviewed": False,
    })


def process_video(video, dropped_quotes):
    work_dir = os.path.join(config.TMP_DIR, video["id"])
    summary = {"video": video["title"], "id": video["id"]}

    try:
        video["upload_date"] = discover.get_upload_date(video["id"])

        log(f"  transcribing ({round(video.get('duration', 0) / 60, 1)} min)...")
        transcript = transcribe.get_transcript(video["id"], work_dir)
        log(f"  transcribed: {len(transcript['segments'])} segments")

        log("  extracting quotes...")
        result = extract_quotes.extract_quotes(video["title"], transcript["text"])
        log(f"    {len(result['entries'])} entries, {len(result['unparsed'])} unparsed")

        if not result["entries"]:
            summary["entries"] = 0
        else:
            write_result = write_notes.write_video_notes(video, result["entries"])
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
            summary.update({
                "entries": len(result["entries"]),
                "confirmed": len(write_result["confirmed"]),
                "duplicates": len(write_result["duplicates"]),
                "skipped": len(write_result["skipped"]),
                "missing": len(write_result["missing"]),
                "failed": len(write_result["failed"]),
                "unparsed": result["unparsed"],
            })

        discover.mark_processed(video["id"])
        summary["status"] = "ok"
    except Exception as e:
        summary["status"] = "error"
        summary["error"] = f"{e}\n{traceback.format_exc()}"
        log(f"  ERROR: {e}")
        # Deliberately NOT marking as processed on error — a transient
        # failure (network blip, API 500) retries next run instead of
        # silently skipping the video forever.
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

    videos, first_run = discover.get_new_videos()

    if first_run:
        log("First run: seeded state with the current channel listing, nothing transcribed. "
            "Future runs will only pick up genuinely new uploads.")
        report_pipeline_status(True, summary="first run: seeded state")
        return

    if not videos:
        log("No new videos since last run.")
        report_pipeline_status(True, summary="no new videos")
        return

    log(f"{len(videos)} new video(s) to process:")
    dropped_quotes = load_dropped_quotes()
    all_summaries = []
    for v in videos:
        log(f"- {v['title']}")
        all_summaries.append(process_video(v, dropped_quotes))
    save_dropped_quotes(dropped_quotes)

    os.makedirs(config.LOG_DIR, exist_ok=True)
    log_path = os.path.join(config.LOG_DIR, "last_run.json")
    with open(log_path, "w") as f:
        json.dump(all_summaries, f, indent=2)
    log(f"\nWrote run summary to {log_path}")

    # A run only counts as a real failure for the dashboard warning when
    # EVERY video in it errored out (the bot-wall pattern — see
    # report_pipeline_status's own comment) — one video failing while
    # others succeed means the infrastructure is fine, nothing to warn
    # about.
    errored = [s for s in all_summaries if s.get("status") == "error"]
    if errored and len(errored) == len(all_summaries):
        report_pipeline_status(False, error=errored[0].get("error", "unknown error")[:500])
    else:
        report_pipeline_status(True, summary={"processed": len(all_summaries), "errored": len(errored)})


if __name__ == "__main__":
    main()
