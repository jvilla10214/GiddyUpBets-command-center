"""Keeneland Barn Notes -> Stable Tour notes.

Checks https://www.keeneland.com/barnnotes for PDFs not yet processed, pulls
each one's text with pdftotext, has Claude pick out the horse quotes
(extract.py), matches speakers to the tracked trainer/jockey rosters, and
saves the notes through the Worker. Runs from GitHub Actions on a schedule
(.github/workflows/keeneland-barn-notes.yml); runnable by hand too.

Filing rules, same as the rest of the notes store:
- a trainer talking about their own horse -> note under that trainer;
- a jockey -> jockey note (no trainer), so it shows wherever the horse runs;
- an owner or anyone else -> note under the horse's trainer, with the
  speaker's name in front ("Davant Latham: ...").
A trainer or jockey named in full who isn't on the roster yet is added.
Quotes already in the store for that horse (via SmartPony etc.) are skipped.
"""
import json
import os
import re
import subprocess
import sys
import time
import unicodedata
from urllib.parse import unquote, urljoin

import requests

import config
import extract

SESSION = requests.Session()
SESSION.headers["User-Agent"] = config.USER_AGENT

MONTHS = {
    "jan": 1, "january": 1, "feb": 2, "february": 2, "mar": 3, "march": 3, "apr": 4, "april": 4,
    "may": 5, "jun": 6, "june": 6, "jul": 7, "july": 7, "aug": 8, "august": 8, "sep": 9, "sept": 9,
    "september": 9, "oct": 10, "october": 10, "nov": 11, "november": 11, "dec": 12, "december": 12,
}
AP_MONTH = {1: "Jan.", 2: "Feb.", 3: "March", 4: "April", 5: "May", 6: "June", 7: "July", 8: "Aug.",
            9: "Sept.", 10: "Oct.", 11: "Nov.", 12: "Dec."}
SUFFIXES = {"jr", "sr", "ii", "iii", "iv"}


def log(msg):
    print(msg, flush=True)


# ---------- name matching (mirrors the Worker's resolveTrackedTrainer) ----------

def _load_worker_name_rules():
    """Reads TRAINER_FIRST_NAME_ALIASES and TRAINER_SUCCESSORS straight out of
    the Worker source in this checkout, so nicknames and "files under another
    trainer" rules stay identical to the live importers without a copy here."""
    path = os.path.join(config.HERE, "..", "..", "workers", "stable-tour-feed.js")
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


def last_key(name):
    toks = _tokens(name)
    return toks[-1] if toks else ""


def norm_token(tok):
    t = tok.lower().rstrip(".")
    return ALIASES.get(t, t)


def resolve(name, roster, use_successors=True):
    if not name:
        return None
    toks = _tokens(name)
    if not toks:
        return None
    if use_successors:
        target = SUCCESSORS.get(f"{norm_token(toks[0])}|{toks[-1]}")
        if target:
            name, toks = target, _tokens(target)
    candidates = [t for t in roster if last_key(t) == toks[-1]]
    if not candidates:
        return None
    if len(toks) < 2:
        return candidates[0] if len(candidates) == 1 else None
    want = norm_token(toks[0])
    hits = [t for t in candidates if any(norm_token(x) == want for x in _strip(t).split())]
    return hits[0] if len(hits) == 1 else None


def is_full_name(name):
    return len(_tokens(name or "")) >= 2


# ---------- Barn Notes listing / PDFs ----------

def list_pdfs():
    r = SESSION.get(config.BARN_NOTES_URL, timeout=30)
    r.raise_for_status()
    urls = []
    for href in re.findall(r'href="([^"]+\.pdf)"', r.text):
        url = urljoin(config.KEENELAND_BASE, href)
        if url not in urls:
            urls.append(url)
    return urls  # page lists newest first


def edition_info(pdf_url):
    """Date and a readable label from a URL like
    /sites/default/files/2026-10/E12%20Thursday%2C%20Oct.%2015.pdf%20%283%29.pdf"""
    fname = unquote(pdf_url.rsplit("/", 1)[-1])
    label = re.sub(r"(\.pdf)+.*$", "", fname, flags=re.I).strip()
    label = re.sub(r"\s*\(\d+\)$", "", label)
    year_m = re.search(r"/files/(\d{4})-(\d{2})/", pdf_url)
    words = re.sub(r"[-_,.]+", " ", label.lower()).split()
    month = day = None
    for i, w in enumerate(words):
        if w in MONTHS and i + 1 < len(words):
            d = re.match(r"(\d{1,2})", words[i + 1])
            if d:
                month, day = MONTHS[w], int(d.group(1))
                break
    date = ""
    if month and year_m:
        date = f"{year_m.group(1)}-{month:02d}-{day:02d}"
    source = f"Keeneland Barn Notes – {AP_MONTH[month]} {day}" if month else "Keeneland Barn Notes"
    return label, date, source


def pdf_text(pdf_url):
    os.makedirs(config.TMP_DIR, exist_ok=True)
    path = os.path.join(config.TMP_DIR, "barn-notes.pdf")
    r = SESSION.get(pdf_url, timeout=60)
    r.raise_for_status()
    with open(path, "wb") as f:
        f.write(r.content)
    out = subprocess.run(["pdftotext", path, "-"], capture_output=True, text=True, check=True)
    return out.stdout


# ---------- Worker I/O ----------

def worker(method, path, body=None):
    for attempt in range(4):
        try:
            r = SESSION.request(method, config.WORKER_BASE + path, json=body, timeout=120)
            r.raise_for_status()
            return r.json()
        except requests.RequestException as e:
            if attempt == 3:
                raise
            log(f"  retrying {path}: {e}")
            time.sleep(3 * (attempt + 1))


def _norm_text(s):
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


def _horse_key(h):
    return re.sub(r"['‘’ʼ]", "'", (h or "").strip().lower())


def _slug(s):
    return re.sub(r"[^a-z0-9]+", "-", _strip(s).lower()).strip("-")


# ---------- main ----------

def build_notes(quotes, data, pdf_url, date, source):
    """Turns extracted quotes into notes. Returns (notes, new_trainers,
    new_jockeys, skipped) — nothing is written here."""
    trainers, jockeys = list(data["trainers"]), list(data["jockeys"])
    new_trainers, new_jockeys, notes, skipped = [], [], [], []
    existing = {}
    # Barn Notes sometimes drops an apostrophe ("Serenas Ghost" for Serena's
    # Ghost). Notes link to entries by horse name, so reuse the spelling
    # already in the store when the names match ignoring punctuation.
    spelling = {}
    for n in data["notes"]:
        existing.setdefault(_horse_key(n.get("horse")), []).append(_norm_text(n.get("note")))
        spelling.setdefault(_norm_text(n.get("horse")), (n.get("horse") or "").strip())

    def trainer_for(name):
        t = resolve(name, trainers)
        if t or not is_full_name(name):
            return t
        trainers.append(name)
        new_trainers.append(name)
        return name

    for q in quotes:
        horse, speaker, role = q["horse"].strip(), q["speaker"].strip(), q["speaker_role"]
        horse = spelling.get(_norm_text(horse), horse)
        text = q["quote"].strip()
        probe = _norm_text(text)[:60]
        if any(probe and probe in old for old in existing.get(_horse_key(horse), [])):
            skipped.append((q, "already in notes"))
            continue
        note = {"horse": horse, "date": date, "source": source, "autoImported": True,
                "importedVia": "keeneland-barn-notes", "sentiment": None}
        if role == "jockey":
            j = resolve(speaker, jockeys, use_successors=False)
            if not j:
                if not is_full_name(speaker):
                    skipped.append((q, "jockey not identified by full name"))
                    continue
                j = speaker
                jockeys.append(j)
                new_jockeys.append(j)
            note.update(trainer="", jockey=j, note=text)
        else:
            filing = trainer_for(q.get("horse_trainer") or (speaker if role == "trainer" else ""))
            if not filing:
                skipped.append((q, "no trainer to file under"))
                continue
            spoke = resolve(speaker, [filing]) if role == "trainer" else None
            note.update(trainer=filing, note=text if spoke else f"{speaker}: {text}")
        # One link per speaker: the Worker dedupes on (trainer, jockey, horse,
        # link), so an owner's and a trainer's quote on the same horse from the
        # same PDF would otherwise collapse into one. The query string doesn't
        # affect the PDF download.
        note["link"] = f"{pdf_url}?speaker={_slug(speaker)}"
        notes.append(note)
        existing.setdefault(_horse_key(horse), []).append(_norm_text(note["note"]))
    return notes, new_trainers, new_jockeys, skipped


def load_state():
    if not os.path.exists(config.PROCESSED_PDFS_PATH):
        return []
    with open(config.PROCESSED_PDFS_PATH) as f:
        return json.load(f)


def save_state(processed):
    os.makedirs(config.STATE_DIR, exist_ok=True)
    with open(config.PROCESSED_PDFS_PATH, "w") as f:
        json.dump(processed, f, indent=2)
        f.write("\n")


def main():
    processed = load_state()
    if config.ONLY_PDF:
        todo = [config.ONLY_PDF]
    else:
        todo = [u for u in reversed(list_pdfs()) if u not in processed][: config.MAX_PDFS_PER_RUN]
    log(f"{len(todo)} Barn Notes PDF(s) to process{' (DRY RUN)' if config.DRY_RUN else ''}")
    failures = 0
    for pdf_url in todo:
        label, date, source = edition_info(pdf_url)
        log(f"\n=== {label} ({date or 'no date'})")
        try:
            quotes = extract.extract_quotes(pdf_text(pdf_url), label)
            data = worker("GET", "/data")
            notes, new_trainers, new_jockeys, skipped = build_notes(quotes, data, pdf_url, date, source)
            for n in notes:
                who = n["trainer"] or f"jockey {n['jockey']}"
                log(f"  + {n['horse']} | {who} | {n['note'][:110]}")
            for q, why in skipped:
                log(f"  - skipped {q['horse']} / {q['speaker']}: {why}")
            if new_trainers:
                log(f"  new trainers: {', '.join(new_trainers)}")
            if new_jockeys:
                log(f"  new jockeys: {', '.join(new_jockeys)}")
            if config.DRY_RUN:
                continue
            if new_trainers:
                worker("POST", "/trainers/bulk", {"names": new_trainers, "source": "keeneland-barn-notes"})
            if new_jockeys:
                worker("POST", "/jockeys/bulk", {"names": new_jockeys, "source": "keeneland-barn-notes"})
            if notes:
                res = worker("POST", "/notes/bulk", {"notes": notes})
                saved = sum(1 for r in res.get("results", []) if not r.get("duplicate"))
                log(f"  saved {saved} of {len(notes)} note(s)")
            if pdf_url not in processed:
                processed.append(pdf_url)
                save_state(processed)
        except Exception as e:  # leave the PDF unprocessed so the next run retries it
            failures += 1
            log(f"  FAILED: {type(e).__name__}: {e}")
    if failures:
        sys.exit(1)


if __name__ == "__main__":
    main()
