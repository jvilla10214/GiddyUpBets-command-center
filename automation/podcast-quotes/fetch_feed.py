"""Fetch the Steve Byk RSS feed, filter to episodes that title-match a
tracked trainer, and track which episodes have already been processed so we
never re-run (or backfill the entire historical catalog) automatically.
"""
import json
import os
import re
import xml.etree.ElementTree as ET

import requests

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


def fetch_tracked_trainers():
    r = requests.get(f"{config.WORKER_BASE}/data", timeout=30)
    r.raise_for_status()
    return r.json().get("trainers", [])


def significant_tokens(full_name):
    """First and last real name words, dropping initials/suffixes like
    'H.' or 'Jr.' — mirrors the matching precision this project already
    needed for trainer-name work (see the Stable Tour audit)."""
    tokens = []
    for part in re.split(r"\s+", full_name.strip()):
        p = part.strip(".,")
        if len(p) <= 1:
            continue
        if p.lower() in ("jr", "sr", "ii", "iii", "iv"):
            continue
        tokens.append(p.lower())
    return tokens


def build_matcher(tracked_trainers, aliases):
    """Returns a function: title -> sorted list of matched tracked trainer names."""
    sig_by_trainer = {t: significant_tokens(t) for t in tracked_trainers}

    def match(title):
        tl = title.lower()
        hits = set()
        for trainer, sig in sig_by_trainer.items():
            if len(sig) >= 2:
                if all(re.search(r"\b" + re.escape(tok) + r"\b", tl) for tok in (sig[0], sig[-1])):
                    hits.add(trainer)
            elif len(sig) == 1:
                if re.search(r"\b" + re.escape(sig[0]) + r"\b", tl):
                    hits.add(trainer)
        for alias, real_name in aliases.items():
            if alias == "_comment":
                continue
            if re.search(r"\b" + re.escape(alias) + r"\b", tl):
                hits.add(real_name)
        return sorted(hits)

    return match


def fetch_feed_items():
    r = requests.get(config.FEED_URL, headers={"User-Agent": config.USER_AGENT}, timeout=30)
    r.raise_for_status()
    root = ET.fromstring(r.content)
    items = []
    for it in root.find("channel").findall("item"):
        enclosure = it.find("enclosure")
        items.append(
            {
                "guid": it.findtext("guid") or it.findtext("link") or it.findtext("title"),
                "title": (it.findtext("title") or "").strip(),
                "pub_date": it.findtext("pubDate"),
                "audio_url": enclosure.get("url") if enclosure is not None else None,
                "audio_length": int(enclosure.get("length")) if enclosure is not None and enclosure.get("length") else None,
            }
        )
    return items


def get_new_matching_episodes():
    """Returns (episodes_to_process, is_first_run).

    On the very first run (no state file yet), every episode currently in
    the feed is marked as seen WITHOUT being queued for processing — the
    feed has 350+ historical episodes, some 100MB+, and silently
    transcribing the entire backlog on day one would be slow and expensive
    for no benefit. Only episodes that appear in the feed on a later run
    (i.e. genuinely new) get processed.
    """
    processed = load_json(config.PROCESSED_GUIDS_PATH, {"guids": []})
    seen = set(processed["guids"])
    is_first_run = len(seen) == 0

    trainers = fetch_tracked_trainers()
    aliases = load_json(config.NICKNAME_ALIASES_PATH, {})
    matcher = build_matcher(trainers, aliases)

    items = fetch_feed_items()

    if is_first_run:
        save_json(config.PROCESSED_GUIDS_PATH, {"guids": [it["guid"] for it in items]})
        return [], True

    to_process = []
    for it in items:
        if it["guid"] in seen:
            continue
        matched = matcher(it["title"])
        if matched:
            it["matched_trainers"] = matched
            to_process.append(it)

    return to_process, False


def mark_processed(guid):
    processed = load_json(config.PROCESSED_GUIDS_PATH, {"guids": []})
    if guid not in processed["guids"]:
        processed["guids"].append(guid)
        save_json(config.PROCESSED_GUIDS_PATH, processed)


if __name__ == "__main__":
    episodes, first_run = get_new_matching_episodes()
    if first_run:
        print("First run: seeded state with the current feed, nothing processed. "
              "Future runs will only pick up genuinely new episodes.")
    else:
        print(f"{len(episodes)} new trainer-matching episode(s) found:")
        for ep in episodes:
            print(f"  - {ep['title']}  ->  {ep['matched_trainers']}")
