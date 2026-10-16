"""Write Maggie Wolfendale's paddock-analysis entries into the shared Stable
Tour store as notes.

A paddock read is the analyst's own third-person observation, not the
trainer's own quote — filed as a normal note with the trainer auto-matched
from that day's real NYRA entries (GET /raceday?track=X&date=Y), text
prefixed "Maggie's Paddock Notes - <observation>" to keep the real source
clear. Same validated design as the original manual process (see
project_nyra_broadcast_quotes_deferred in memory).

If the horse isn't found in that day's entries for any tracked NYRA track
(wrong track that day, a transcription slip, or a horse at a track this
store doesn't archive), the note is still filed trainer-less rather than
dropped — same "horse is the most important" precedent already established
for this exact situation (Long-Legged Queen, 2026-09-20): a real observation
about a real-sounding horse is worth keeping even without a confident
trainer, and trainer/jockey is never guessed at the cost of losing the
horse-note link.

Name resolution (nickname/successor-aware) is ported from
automation/kentucky-hbpa/write_notes.py rather than shared, per this
project's "duplicate the working pipeline" convention for automation/.
"""
import os
import re
import time
import unicodedata
from collections import defaultdict

import requests

import config

NOTES_URL = f"{config.WORKER_BASE}/notes"
TRAINERS_URL = f"{config.WORKER_BASE}/trainers"
JOCKEYS_URL = f"{config.WORKER_BASE}/jockeys"

SUFFIXES = {"jr", "sr", "ii", "iii", "iv"}


def _load_worker_name_rules():
    path = os.path.join(os.path.dirname(__file__), "..", "..", "workers", "stable-tour-feed.js")
    src = open(path, encoding="utf-8").read()

    def block(name):
        m = re.search(r"const " + name + r" = \{(.*?)\n\};", src, re.S)
        return m.group(1) if m else ""

    aliases = dict(re.findall(r'\b([a-z]+):\s*"([a-z]+)"', block("TRAINER_FIRST_NAME_ALIASES")))
    successors = dict(re.findall(r'"([a-z]+\|[a-z\-]+)":\s*"([^"]+)"', block("TRAINER_SUCCESSORS")))
    return aliases, successors


ALIASES, SUCCESSORS = _load_worker_name_rules()


def _strip(s):
    s = unicodedata.normalize("NFD", s)
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    return re.sub(r"['‘’ʼʻ]", "", s)


def _tokens(name):
    toks = [t.lower().rstrip(".,") for t in _strip(name).split()]
    while len(toks) > 1 and toks[-1] in SUFFIXES:
        toks.pop()
    return toks


def _last_key(name):
    toks = _tokens(name)
    return toks[-1] if toks else ""


def _norm_token(tok):
    t = tok.lower().rstrip(".")
    return ALIASES.get(t, t)


def resolve_name(candidate, tracked_names):
    if candidate in tracked_names:
        return candidate
    toks = _tokens(candidate)
    if toks:
        target = SUCCESSORS.get(f"{_norm_token(toks[0])}|{toks[-1]}")
        if target and target in tracked_names:
            return target
        last = toks[-1]
        candidates = [t for t in tracked_names if _last_key(t) == last]
        if len(candidates) == 1 and len(toks) < 2:
            return candidates[0]
        if len(toks) >= 2:
            want = _norm_token(toks[0])
            hits = [t for t in candidates if any(_norm_token(x) == want for x in _strip(t).split())]
            if len(hits) == 1:
                return hits[0]
    lowered = {t.lower(): t for t in tracked_names}
    return lowered.get(candidate.lower())


def ensure_tracked(name, tracked_names, add_url=TRAINERS_URL, source_tag=config.TRAINER_SOURCE_TAG):
    resolved = resolve_name(name, tracked_names)
    if resolved:
        return resolved
    r = requests.post(add_url, json={"name": name, "source": source_tag}, timeout=30)
    r.raise_for_status()
    return name


def _horse_key(name):
    # Strips a trailing country suffix like "(GB)"/"(FR)" — the entries data
    # carries these, Maggie's spoken mention of the horse usually doesn't.
    name = re.sub(r"\s*\([A-Z]{2,4}\)\s*$", "", name or "")
    return _strip(name).strip().lower()


def fetch_horse_trainer_map(date):
    """Tries each NYRA track this store archives Race Day data for, returns
    a {normalized horse name: trainer} map merged across whichever track(s)
    actually raced that day. Empty dict if none did (wrong track, or a date
    this store never archived)."""
    mapping = {}
    for track in config.RACEDAY_TRACKS:
        r = requests.get(f"{config.WORKER_BASE}/raceday", params={"track": track, "date": date}, timeout=30)
        r.raise_for_status()
        data = r.json()
        if not data.get("available"):
            continue
        for race in data.get("entries", []):
            for horse in race.get("horses", []):
                name, trainer = horse.get("name"), horse.get("trainer")
                if name and trainer:
                    mapping[_horse_key(name)] = trainer
    return mapping


def fetch_data():
    r = requests.get(f"{config.WORKER_BASE}/data", timeout=30)
    r.raise_for_status()
    return r.json()


def post_note(payload):
    r = requests.post(NOTES_URL, json=payload, timeout=30)
    r.raise_for_status()
    return r.json()


def post_note_verified(payload, max_attempts=5):
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


def write_paddock_notes(video, entries):
    """video: {id, title, upload_date}; entries: parsed list from
    extract_quotes.py (each with timestamp/horse/observation)."""
    horse_trainer_map = fetch_horse_trainer_map(video.get("upload_date", ""))
    tracked_trainers = fetch_data().get("trainers", [])

    confirmed, duplicates, lost, failed, skipped = [], [], [], [], []

    for entry in entries:
        horse = (entry.get("horse") or "").strip()
        if not horse or "unclear" in horse.lower() or "/" in horse:
            skipped.append({"entry": entry, "reason": "no_clear_horse"})
            continue

        trainer_name = horse_trainer_map.get(_horse_key(horse))
        resolved_trainer = ""
        if trainer_name:
            try:
                resolved_trainer = ensure_tracked(trainer_name, tracked_trainers)
                if resolved_trainer not in tracked_trainers:
                    tracked_trainers.append(resolved_trainer)
            except requests.HTTPError as e:
                failed.append({"entry": entry, "error": f"auto-track failed: {e}"})
                continue

        ts_suffix = entry["timestamp"].replace(":", "")
        link = f"https://www.youtube.com/watch?v={video['id']}&t={ts_suffix}"
        payload = {
            "trainer": resolved_trainer,
            "horse": horse,
            "note": f"Maggie's Paddock Notes - {entry['observation']}",
            "link": link,
            "date": video.get("upload_date", ""),
            "source": f"NYRA Broadcast — {video['title']}",
            "autoImported": True,
            "importedVia": "nyra-broadcast-maggie",
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


def write_interview_notes(video, entries):
    """video: {id, title, upload_date}; entries: parsed list from
    extract_interviews.py (each with timestamp/speaker/role/horse/question/
    quote). Only trainer/jockey roles get filed — an "other" speaker (an
    owner, a steward, color commentary) is real content but has no field for
    it in the note schema, same convention as automation/kentucky-hbpa/."""
    data = fetch_data()
    tracked_trainers = data.get("trainers", [])
    tracked_jockeys = data.get("jockeys", [])

    confirmed, duplicates, lost, failed, skipped = [], [], [], [], []
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
                resolved_name = ensure_tracked(speaker, tracked_trainers, TRAINERS_URL, config.INTERVIEW_TRAINER_SOURCE_TAG)
                if resolved_name not in tracked_trainers:
                    tracked_trainers.append(resolved_name)
                field_name, field_value = "trainer", resolved_name
            else:
                resolved_name = ensure_tracked(speaker, tracked_jockeys, JOCKEYS_URL, config.INTERVIEW_JOCKEY_SOURCE_TAG)
                if resolved_name not in tracked_jockeys:
                    tracked_jockeys.append(resolved_name)
                field_name, field_value = "jockey", resolved_name
        except requests.HTTPError as e:
            failed.append({"entry": entry, "error": f"auto-track failed: {e}"})
            continue

        # Running per-(horse, timestamp) counter for link uniqueness — a
        # flowing answer can give several distinct bullets the same model
        # timestamp, which would otherwise collapse under the Worker's
        # (name, horse, link) dedup (confirmed real in the Kentucky HBPA
        # pipeline's own testing).
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
            "source": f"NYRA Broadcast — {video['title']}",
            "autoImported": True,
            "importedVia": "nyra-broadcast-interview",
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
