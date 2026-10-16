"""Write extracted trainer/jockey Q&A entries into the shared Stable Tour
store as notes.

Two real differences from automation/podcast-quotes/write_notes.py, both
found by testing extract_quotes.py against real samples before writing this:

- **Auto-track instead of requiring a pre-tracked name.** The Byk pipeline
  only ever processes a trainer it already knows is tracked (the title-match
  filter guarantees that). This channel has no such filter — a name here can
  be completely new. Current standing policy (2026-10-11) is to auto-add any
  trainer/jockey a real quote names rather than drop the quote, tagged
  `kentuckyhbpa-auto-unverified` for the weekly audit. See
  project_auto_track_trainers_shipped_2026-10-11 in memory.
- **Link uniqueness can't trust the model's timestamp alone.** Confirmed with
  a real sample (6 Q&A bullets about "The Puma," all stamped the same
  [00:26] because the source was one continuous flowing answer, not discrete
  questions) — the Worker dedupes on (trainer/jockey, horse, link), so an
  identical timestamp for the same horse would silently collapse distinct
  quotes into one, the exact failure mode the Byk pipeline's own comment
  warns about. Fixed by appending a running per-(horse, timestamp) counter to
  the link instead of trusting the timestamp to already be unique.

Only trainer/jockey entries get filed — the note schema has no field for an
owner/agent/broadcaster's commentary. Those are real content, not noise, so
they're recorded in the dropped-quotes log (reason "non_trainer_jockey_role")
rather than silently discarded, same as every other skip reason this
project already tracks.
"""
import time
from collections import defaultdict

import requests

import config

NOTES_URL = f"{config.WORKER_BASE}/notes"
TRAINERS_URL = f"{config.WORKER_BASE}/trainers"
JOCKEYS_URL = f"{config.WORKER_BASE}/jockeys"


def fetch_data():
    r = requests.get(f"{config.WORKER_BASE}/data", timeout=30)
    r.raise_for_status()
    return r.json()


def resolve_name(candidate, tracked_names):
    """Exact match first, then case-insensitive — same convention as the Byk
    pipeline's resolve_trainer_name."""
    if candidate in tracked_names:
        return candidate
    lowered = {t.lower(): t for t in tracked_names}
    return lowered.get(candidate.lower())


def ensure_tracked(name, tracked_names, add_url, source_tag):
    """Returns the resolved tracked name, auto-adding it first if it's
    genuinely new. Mirrors the Worker's own auto-track behavior for its
    import jobs (SmartPony, BloodHorse, etc.) — this pipeline runs outside
    the Worker, so it has to do the same POST /trainers or /jockeys call
    itself rather than relying on server-side auto-add logic that only
    exists for those jobs."""
    resolved = resolve_name(name, tracked_names)
    if resolved:
        return resolved
    r = requests.post(add_url, json={"name": name, "source": source_tag}, timeout=30)
    r.raise_for_status()
    return name


def post_note(payload):
    r = requests.post(NOTES_URL, json=payload, timeout=30)
    r.raise_for_status()
    return r.json()


def post_note_verified(payload, max_attempts=5):
    """Same race-safe pattern as the Byk pipeline: retry the POST itself (not
    just re-check) since the dedup key means a retry either creates the note
    for real or matches the dedup and hands back the original — either way
    converges on the note actually existing. A real KV read-modify-write
    race has repeatedly dropped notes under rapid sequential writes in this
    project even with a delay between them."""
    last_note = None
    for attempt in range(max_attempts):
        result = post_note(payload)
        last_note = result["note"]
        if result.get("duplicate") and attempt > 0:
            return last_note, "confirmed_after_retry"
        data = fetch_data()
        if any(n["id"] == last_note["id"] for n in data.get("notes", [])):
            return last_note, "duplicate" if result.get("duplicate") else "confirmed"
        time.sleep(3 * (attempt + 1))
    return last_note, "lost"


def write_video_notes(video, entries):
    """video: {id, title, upload_date}; entries: parsed list from
    extract_quotes.py (each with speaker/role/horse/question/quote/timestamp).
    """
    data = fetch_data()
    tracked_trainers = data.get("trainers", [])
    tracked_jockeys = data.get("jockeys", [])

    confirmed, duplicates, lost, failed, skipped = [], [], [], [], []

    # De-dupe-safe link suffixes: count how many times (horse, timestamp)
    # repeats in this video's entries and append the running index, so a
    # flat/non-incrementing model timestamp can't collapse distinct quotes.
    seen_counts = defaultdict(int)

    for entry in entries:
        role = entry.get("role", "")
        horse = (entry.get("horse") or "").strip()
        speaker = (entry.get("speaker") or "").strip()

        if not horse or "unclear" in horse.lower() or "/" in horse:
            skipped.append({"entry": entry, "reason": "no_clear_horse"})
            continue
        if not speaker or speaker.lower() == "unclear":
            skipped.append({"entry": entry, "reason": "no_clear_speaker"})
            continue
        if role not in ("trainer", "jockey"):
            skipped.append({"entry": entry, "reason": "non_trainer_jockey_role"})
            continue

        try:
            if role == "trainer":
                resolved_name = ensure_tracked(
                    speaker, tracked_trainers, TRAINERS_URL, config.TRAINER_SOURCE_TAG
                )
                if resolved_name not in tracked_trainers:
                    tracked_trainers.append(resolved_name)
                field_name, field_value = "trainer", resolved_name
            else:
                resolved_name = ensure_tracked(
                    speaker, tracked_jockeys, JOCKEYS_URL, config.JOCKEY_SOURCE_TAG
                )
                if resolved_name not in tracked_jockeys:
                    tracked_jockeys.append(resolved_name)
                field_name, field_value = "jockey", resolved_name
        except requests.HTTPError as e:
            failed.append({"entry": entry, "error": f"auto-track failed: {e}"})
            continue

        dedup_key = (horse.lower(), entry["timestamp"])
        idx = seen_counts[dedup_key]
        seen_counts[dedup_key] += 1
        ts_suffix = entry["timestamp"].replace(":", "")
        link = f"https://www.youtube.com/watch?v={video['id']}&t={ts_suffix}"
        if idx > 0:
            link += f"-{idx}"

        note_text = f"{entry['question']} {entry['quote']}".strip()
        payload = {
            field_name: field_value,
            "horse": horse,
            "note": note_text,
            "link": link,
            "date": video.get("upload_date", ""),
            "source": f"Kentucky HBPA — {video['title']}",
            "autoImported": True,
            "importedVia": "kentucky-hbpa",
        }

        try:
            note, status = post_note_verified(payload)
            if status == "lost":
                lost.append({"entry": entry, "note": note})
            elif status == "duplicate":
                duplicates.append(note)
            else:
                confirmed.append(note)
        except requests.HTTPError as e:
            failed.append({"entry": entry, "error": str(e)})
        time.sleep(0.6)

    return {
        "confirmed": confirmed,
        "missing": lost,
        "failed": failed,
        "duplicates": duplicates,
        "skipped": skipped,
    }


if __name__ == "__main__":
    print("This module is meant to be called from run.py with real extracted entries.")
