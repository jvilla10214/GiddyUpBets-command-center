"""Orchestrator: check the feed for new trainer-featuring episodes, and for
each one, transcribe -> extract -> write to the Stable Tour store. Meant to
run unattended from GitHub Actions (see .github/workflows/podcast-quotes.yml)
on a schedule, but is just as runnable by hand for testing.

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

import config
import extract_quotes
import fetch_feed
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


def record_dropped(dropped_list, episode, trainer, reason, entry, error=None):
    """Append-only record of a quote the pipeline found but didn't file —
    either no clean single horse ("skipped"), lost to the KV write race even
    after retries ("missing"), or a hard API failure ("failed"). Previously
    these only ever showed up as a count in logs/last_run.json, which the
    very next run overwrites — so a dropped quote vanished with no trace
    once the next scheduled run fired. Deduped by (episode guid, timestamp)
    so re-running the same episode (e.g. after a partial failure) doesn't
    pile up duplicate entries for the same dropped quote."""
    key = f"{episode['guid']}|{entry.get('timestamp', '')}"
    if any(d["key"] == key for d in dropped_list):
        return
    dropped_list.append({
        "key": key,
        "reason": reason,
        "episode": episode["title"],
        "episodeDate": episode.get("pub_date", ""),
        "trainer": trainer,
        "horse": entry.get("horse", ""),
        "quote": entry.get("quote", ""),
        "question": entry.get("question", ""),
        "timestamp": entry.get("timestamp", ""),
        "error": error,
        "foundAt": datetime.datetime.utcnow().isoformat() + "Z",
        "reviewed": False,
    })


def process_episode(episode, dropped_quotes):
    work_dir = os.path.join(config.TMP_DIR, episode["guid"])
    summary = {"episode": episode["title"], "trainers": {}}

    try:
        log(f"  transcribing ({episode.get('audio_length', 0) // (1024*1024)}MB)...")
        transcript = transcribe.transcribe_episode(
            episode["audio_url"], work_dir, guest_names=episode["matched_trainers"]
        )
        log(f"  transcribed: {len(transcript['segments'])} segments")

        for trainer in episode["matched_trainers"]:
            log(f"  extracting quotes for {trainer}...")
            result = extract_quotes.extract_quotes(
                transcript["text"], episode["matched_trainers"], [trainer]
            )
            log(f"    {len(result['entries'])} entries, {len(result['unparsed'])} unparsed")

            if not result["entries"]:
                summary["trainers"][trainer] = {"entries": 0}
                continue

            write_result = write_notes.write_episode_notes(episode, result["entries"], trainer)
            log(
                f"    wrote {len(write_result['confirmed'])} confirmed, "
                f"{len(write_result['duplicates'])} already existed, "
                f"{len(write_result['skipped'])} skipped (no clear horse), "
                f"{len(write_result['missing'])} missing after verify, "
                f"{len(write_result['failed'])} failed"
            )
            for entry in write_result["skipped"]:
                record_dropped(dropped_quotes, episode, trainer, "no_clear_horse", entry)
            for item in write_result["missing"]:
                record_dropped(dropped_quotes, episode, trainer, "lost_after_verify", item["entry"])
            for item in write_result["failed"]:
                record_dropped(dropped_quotes, episode, trainer, "write_failed", item["entry"], error=item["error"])
            summary["trainers"][trainer] = {
                "entries": len(result["entries"]),
                "confirmed": len(write_result["confirmed"]),
                "duplicates": len(write_result["duplicates"]),
                "skipped": len(write_result["skipped"]),
                "missing": len(write_result["missing"]),
                "failed": len(write_result["failed"]),
                "unparsed": result["unparsed"],
            }

        fetch_feed.mark_processed(episode["guid"])
        summary["status"] = "ok"
    except Exception as e:
        summary["status"] = "error"
        summary["error"] = f"{e}\n{traceback.format_exc()}"
        log(f"  ERROR: {e}")
        # Deliberately NOT marking as processed on error — a transient
        # failure (network blip, API 500) should retry on the next run
        # rather than silently skip the episode forever.
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

    episodes, first_run = fetch_feed.get_new_matching_episodes()

    if first_run:
        log(
            "First run: seeded state with the current feed (350+ historical episodes), "
            "nothing transcribed. Future runs will only pick up genuinely new episodes."
        )
        return

    if not episodes:
        log("No new trainer-featuring episodes since last run.")
        return

    log(f"{len(episodes)} new trainer-featuring episode(s) to process:")
    dropped_quotes = load_dropped_quotes()
    all_summaries = []
    for ep in episodes:
        log(f"- {ep['title']}  (trainers: {', '.join(ep['matched_trainers'])})")
        all_summaries.append(process_episode(ep, dropped_quotes))
    save_dropped_quotes(dropped_quotes)

    os.makedirs(config.LOG_DIR, exist_ok=True)
    log_path = os.path.join(config.LOG_DIR, "last_run.json")
    with open(log_path, "w") as f:
        json.dump(all_summaries, f, indent=2)
    log(f"\nWrote run summary to {log_path}")


if __name__ == "__main__":
    main()
