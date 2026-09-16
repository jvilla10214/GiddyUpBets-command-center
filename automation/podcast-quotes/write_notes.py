"""Write extracted Q&A entries into the shared Stable Tour store as notes,
one horse/trainer per note — same conventions established and validated
during this session's Stable Tour accuracy audit, plus two more real bugs
found and fixed while building this pipeline specifically:

- match the trainer's EXACT tracked spelling (curly apostrophes etc.) before
  writing, since every Stable Tour view filters out notes whose trainer
  isn't in the tracked list.
- individual POST /notes calls, not /notes/bulk (bulk silently drops any
  item missing a trainer).
- entries without a clean, single, identified horse are skipped rather than
  filed under a placeholder.
- each quote gets a `link` unique to its own timestamp within the episode
  (`#t=HHMMSS`), not the bare episode URL — the Worker dedupes on (trainer,
  horse, link), and one episode routinely has several distinct exchanges
  about the same horse, which a shared link would silently collapse into
  just the first one. Confirmed while testing: 6 separate quotes about one
  horse in one episode, only 1 survived, before this fix.
- every POST is followed by an immediate re-fetch to confirm the note
  actually landed, retrying the POST itself (not just re-checking) if it
  didn't — a real KV read-modify-write race has been observed to silently
  drop notes under rapid sequential writes even with a delay between them
  (confirmed again while building this: 7 of 16 writes vanished with a 0.6s
  gap and no retry). See project_atr_byk_podcast_prompt_2026-08-26 for the
  earlier occurrence of this same race.
"""
import time
from email.utils import parsedate_to_datetime

import requests

import config

NOTES_URL = f"{config.WORKER_BASE}/notes"
TRAINERS_URL = f"{config.WORKER_BASE}/trainers"


def fetch_data():
    r = requests.get(f"{config.WORKER_BASE}/data", timeout=30)
    r.raise_for_status()
    return r.json()


def resolve_trainer_name(candidate, tracked_trainers):
    """Exact match first (handles curly apostrophes etc. correctly since the
    caller should already be passing the tracked spelling for anything we
    pre-filtered on); falls back to a case-insensitive match."""
    if candidate in tracked_trainers:
        return candidate
    lowered = {t.lower(): t for t in tracked_trainers}
    return lowered.get(candidate.lower())


def rss_pubdate_to_date_str(pub_date):
    """RSS pubDate is RFC 2822 ('Tue, 15 Sep 2026 17:28:57 GMT') — every other
    note in this store uses a plain YYYY-MM-DD date string."""
    if not pub_date:
        return ""
    try:
        return parsedate_to_datetime(pub_date).strftime("%Y-%m-%d")
    except (TypeError, ValueError):
        return ""


def post_note(trainer, horse, note_text, link, date, source):
    body = {
        "trainer": trainer,
        "horse": horse,
        "note": note_text,
        "link": link,
        "date": date,
        "source": source,
        "autoImported": True,
        "importedVia": "steve-byk-podcast",
    }
    r = requests.post(NOTES_URL, json=body, timeout=30)
    r.raise_for_status()
    return r.json()


def post_note_verified(trainer, horse, note_text, link, date, source, max_attempts=5):
    """POST a note and confirm — by re-fetching /data — that it actually
    landed before moving on. A real KV read-modify-write race has been
    observed to silently drop notes under rapid sequential POSTs even with a
    delay between them (confirmed again while building this pipeline: 7 of
    16 writes vanished with a 0.6s gap). Retrying the POST itself (not just
    re-checking) is deliberate — since the dedup key is (trainer, horse,
    link), a retry either creates the note for real this time or matches
    the dedup and hands back the original, either way converging on the
    note actually existing."""
    last_note = None
    for attempt in range(max_attempts):
        result = post_note(trainer, horse, note_text, link, date, source)
        last_note = result["note"]
        if result.get("duplicate") and attempt > 0:
            # Our own earlier attempt in this loop actually landed — confirmed.
            return last_note, "confirmed_after_retry"
        data = fetch_data()
        if any(n["id"] == last_note["id"] for n in data.get("notes", [])):
            return last_note, "duplicate" if result.get("duplicate") else "confirmed"
        # Cleanup testing while building this pipeline showed the /data read
        # can lag several seconds behind a write (and even behind a DELETE),
        # not just under back-to-back rapid writes — so this backs off more
        # than the original race-mitigation elsewhere in this project did.
        time.sleep(3 * (attempt + 1))
    return last_note, "lost"


def write_episode_notes(episode, entries, trainer_hint):
    """episode: {title, audio_url, pub_date, guid}; entries: parsed Q&A list
    (each with horse/quote/question/timestamp); trainer_hint: the single
    tracked trainer name this batch of entries belongs to (the pipeline runs
    one extraction pass per matched trainer per episode, so this is known
    going in, not re-derived from free text)."""
    data = fetch_data()
    tracked = data.get("trainers", [])
    resolved_trainer = resolve_trainer_name(trainer_hint, tracked)
    if not resolved_trainer:
        raise ValueError(
            f"'{trainer_hint}' is not in the tracked trainers list — add it via POST /trainers "
            "first, or this note would be silently hidden from every Stable Tour view."
        )

    date_str = rss_pubdate_to_date_str(episode.get("pub_date"))
    confirmed, duplicates, lost, failed, skipped = [], [], [], [], []

    for entry in entries:
        horse = (entry.get("horse") or "").strip()
        # Drop anything without a clean, single, identified horse rather than
        # file it under a placeholder — confirmed preference: don't clutter
        # a trainer's real Stable Tour notes with no-horse banter.
        if not horse or "unclear" in horse.lower() or "/" in horse:
            skipped.append(entry)
            continue
        note_text = f"{entry['question']} {entry['quote']}".strip()
        # The Worker dedupes on (trainer, horse, link) to stop re-imports of
        # the same article from creating repeat notes — but one episode
        # routinely has several DIFFERENT Q&A exchanges about the same
        # horse, which would otherwise all collapse into just the first one
        # (confirmed while testing: 6 distinct Two Aflame quotes in one
        # episode, only 1 survived). A timestamp fragment keeps the link
        # genuinely unique per quote while still pointing at the real
        # episode — the same "#chunk=N" convention this store already uses
        # for distinct passages within one PDF source.
        ts_suffix = entry["timestamp"].replace(":", "")
        link = f"{episode['audio_url']}#t={ts_suffix}"
        try:
            note, status = post_note_verified(
                trainer=resolved_trainer,
                horse=horse,
                note_text=note_text,
                link=link,
                date=date_str,
                source=f"At the Races with Steve Byk — {episode['title']}",
            )
            if status == "lost":
                lost.append({"entry": entry, "note": note})
            elif status == "duplicate":
                duplicates.append(note)
            else:
                confirmed.append(note)
        except requests.HTTPError as e:
            failed.append({"entry": entry, "error": str(e)})
        time.sleep(0.6)  # extra spacing between different notes, on top of post_note_verified's own retries

    return {
        "confirmed": confirmed,
        "missing": lost,
        "failed": failed,
        "duplicates": duplicates,
        "skipped": skipped,
    }


if __name__ == "__main__":
    print("This module is meant to be called from run.py with real extracted entries.")
