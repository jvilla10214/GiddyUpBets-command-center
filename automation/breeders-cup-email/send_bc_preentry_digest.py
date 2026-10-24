"""One-off Breeders' Cup pre-entry digest emails — see README.md.

Not a recurring pipeline. Reads BREEDERS_CUP_2026 out of index.html, fetches live
Stable Tour notes, builds two emails (Friday, Saturday), sends each through the
Worker's /send-custom-email route. Standard library only, deliberately, so a
fresh checkout can run this with no setup step.
"""
import html
import json
import re
import sys
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
WORKER_BASE = "https://stable-tour-feed.jvilla10214.workers.dev"
BROWSER_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0 Safari/537.36"
)

# Keeneland's real sampled theme color (from its own favicon, #0d5c44) — see
# STYLED_DIGEST_TRACK_THEME in workers/stable-tour-feed.js. Breeders' Cup runs
# at Keeneland this year, so this is the correct theme to reuse, not a new
# invented palette.
THEME = {"accent": "#0d5c44", "bg": "#f6fbf8", "ink": "#123328", "dim": "#5c8274", "hairline": "#dcece4"}

# Same fixed colors as NOTE_TYPE_RIBBON_COLORS in workers/stable-tour-feed.js
# — all three fixed, not THEME['accent'], so "indigo = quote / gold = race
# recap / steel blue = full card recap" stays a reliable shortcut across
# every track's email, BC's own Keeneland-green included. Quote was
# originally THEME['accent'] here too (matching the Worker's own pre-2026-
# 10-24 design) until a real user-reported bug: that made the QUOTE ribbon
# the same color as the race-tag badge directly above it, so the two
# blended together. Fixed alongside the Worker's own copy of this same bug.
NOTE_TYPE_RIBBON_COLORS = {"quote": "#5b4e8f", "race": "#c99a2e", "fullCard": "#4a6b8a"}

COUNTRY_SUFFIX_RE = re.compile(r"\s*\([a-zA-Z]{2,4}\)\s*$")


def normalize_horse_key(name):
    return COUNTRY_SUFFIX_RE.sub("", (name or "").strip()).strip().lower()


def fetch_url(url, method="GET", body=None):
    req = urllib.request.Request(url, method=method, headers={"User-Agent": BROWSER_UA})
    if body is not None:
        req.add_header("Content-Type", "application/json")
        req.data = json.dumps(body).encode("utf-8")
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def load_bc_data():
    text = (REPO_ROOT / "index.html").read_text(encoding="utf-8")
    m = re.search(r"const BREEDERS_CUP_2026 = (\{.*?\n  \});\n", text, re.S)
    if not m:
        raise RuntimeError("Could not find BREEDERS_CUP_2026 in index.html")
    return json.loads(m.group(1))


def esc(s):
    return html.escape(s or "", quote=False)


def notes_for_horse(all_notes, tracked_trainers, horse_name):
    key = horse_name.strip().lower()
    matches = [n for n in all_notes if (n.get("horse") or "").strip().lower() == key]
    # Same rule the frontend's BC notes subsection uses: a trainer-less note
    # always shows; a note naming a trainer only shows once that trainer is
    # actually tracked.
    matches = [n for n in matches if not n.get("trainer") or n["trainer"] in tracked_trainers]
    matches.sort(key=lambda n: (n.get("date") or "", n.get("capturedAt") or ""), reverse=True)
    # Full history, not capped — user confirmed 2026-10-24 Gmail's clip
    # threshold is fine, this should show everything we have.
    return matches


def note_card_html(n):
    role_icon = "&#127908;" if n.get("trainer") else "&#127943;"
    role_label = "Trainer" if n.get("trainer") else "Jockey"
    speaker = n.get("trainer") or n.get("jockey") or ""
    source = n.get("source") or ("auto-imported" if n.get("autoImported") else "manual")
    quote_hue = NOTE_TYPE_RIBBON_COLORS["quote"]
    return f"""
    <div style="border-radius:6px; overflow:hidden; margin:4px 0 8px;">
      <div style="background:{quote_hue}; color:#ffffff; font-family:Arial,Helvetica,sans-serif; font-weight:700; font-size:10.5px; letter-spacing:0.05em; padding:6px 12px;">{role_icon} QUOTE &mdash; {esc(n.get('date') or '—')}</div>
      <div style="background:{quote_hue}12; padding:10px 12px; font-family:Georgia,'Times New Roman',serif; font-size:13.5px; line-height:1.5; color:{THEME['ink']};">
        {esc(n.get('note'))}
        <div style="font-family:Arial,Helvetica,sans-serif; font-size:10.5px; color:{THEME['dim']}; margin-top:5px;"><strong style="color:{THEME['ink']};">{esc(speaker)}</strong> ({role_label}) &middot; {esc(source)}</div>
      </div>
    </div>"""


def ribbon_block_html(hue, icon, label, body_html):
    return f"""
    <div style="border-radius:6px; overflow:hidden; margin:4px 0 8px;">
      <div style="background:{hue}; color:#ffffff; font-family:Arial,Helvetica,sans-serif; font-weight:700; font-size:10.5px; letter-spacing:0.05em; padding:6px 12px;">{icon} {label}</div>
      <div style="background:{hue}12; padding:10px 12px; font-family:Georgia,'Times New Roman',serif; font-size:13.5px; line-height:1.5; color:{THEME['ink']};">{body_html}</div>
    </div>"""


def recaps_for_horse(recap_index, horse_name):
    key = normalize_horse_key(horse_name)
    entries = recap_index.get(key, [])
    return sorted(entries, key=lambda e: e.get("date") or "", reverse=True)


def recap_cards_html(entries):
    """Full Card Recap box (when present) sits above its matching Race Recap
    box, broad context before the specific race — same order and same fixed
    colors as buildStyledEntryDigestEmail() in workers/stable-tour-feed.js."""
    parts = []
    for e in entries:
        date_label = e.get("date") or "—"
        origin_tag = f" &middot; {esc(e['track'])}" if e.get("track") else ""
        if e.get("fullCardRecap"):
            parts.append(ribbon_block_html(
                NOTE_TYPE_RIBBON_COLORS["fullCard"], "&#128197;",
                f"FULL CARD RECAP &mdash; {esc(date_label)}{origin_tag}", esc(e["fullCardRecap"]),
            ))
        if e.get("recap"):
            race_tag = f" RACE {e['raceNumber']}" if e.get("raceNumber") else ""
            parts.append(ribbon_block_html(
                NOTE_TYPE_RIBBON_COLORS["race"], "&#127937;",
                f"RACE RECAP &mdash; {esc(date_label)}{race_tag}{origin_tag}", esc(e["recap"]),
            ))
    return "".join(parts)


def race_html(race, all_notes, tracked_trainers, recap_index):
    tag = f"RACE {race['num']} &middot; {esc(race['post'])} &middot; {esc(race['purse'])} {esc(race['cond'])} &middot; {esc(race['dist'])} {esc(race['surf'])}"
    horses = sorted(race["horses"], key=lambda h: h["name"].lower())
    horses_html = []
    for idx, h in enumerate(horses):
        divider = f'<div style="border-top:1px dashed {THEME["hairline"]}; margin:14px 0 10px;"></div>' if idx > 0 else ""
        recaps_html = recap_cards_html(recaps_for_horse(recap_index, h["name"]))
        notes = notes_for_horse(all_notes, tracked_trainers, h["name"])
        notes_html = "".join(note_card_html(n) for n in notes)
        horses_html.append(f"""
        {divider}
        <div style="margin:10px 0 3px;">
          <span style="font-family:Arial,Helvetica,sans-serif; font-weight:700; font-size:15px; color:{THEME['ink']};">{esc(h['name'])}</span>
        </div>
        {recaps_html}
        {notes_html}""")
    return f"""
      <div style="padding:16px 30px; border-bottom:1px solid {THEME['hairline']};">
        <span style="display:inline-block; font-family:Arial,Helvetica,sans-serif; font-weight:700; font-size:11px; letter-spacing:0.06em; background:{THEME['accent']}; color:#ffffff; padding:3px 9px; border-radius:3px; margin-bottom:10px;">{tag}</span>
        {''.join(horses_html)}
      </div>"""


def build_day_email(day, all_notes, tracked_trainers, recap_index):
    horse_count = sum(len(r["horses"]) for r in day["races"])
    subject = f"GiddyUpQuotes — Breeders' Cup Pre-Entries — {day['label']} ({horse_count} horses, draw not yet made)"
    races_html = "".join(race_html(r, all_notes, tracked_trainers, recap_index) for r in day["races"])
    html_body = f"""
    <div style="background:{THEME['bg']}; color:{THEME['ink']}; font-family:Georgia,'Times New Roman',serif; max-width:640px; margin:0 auto;">
      <div style="padding:26px 30px 20px; text-align:center; border-bottom:3px double {THEME['accent']};">
        <div style="font-family:Arial,Helvetica,sans-serif; font-weight:700; font-size:22px; color:{THEME['accent']}; margin-bottom:6px;">GiddyUpQuotes &mdash; Breeders' Cup Pre-Entries</div>
        <div style="font-family:'Courier New',Courier,monospace; font-size:11px; color:{THEME['dim']};">Keeneland &middot; {esc(day['label'])} &middot; {horse_count} pre-entered horses &middot; PRE-ENTRIES &mdash; DRAW NOT YET MADE</div>
      </div>
      {races_html}
    </div>"""
    return subject, html_body


def main():
    bc_data = load_bc_data()
    data = fetch_url(f"{WORKER_BASE}/data")
    all_notes = data.get("notes", [])
    tracked_trainers = set(data.get("trainers", []))
    recap_index = fetch_url(f"{WORKER_BASE}/recap-index").get("byHorse", {})

    for day in bc_data["days"]:
        subject, html_body = build_day_email(day, all_notes, tracked_trainers, recap_index)
        result = fetch_url(f"{WORKER_BASE}/send-custom-email", method="POST", body={"subject": subject, "html": html_body})
        print(f"{day['label']}: sent -> {result}", flush=True)


if __name__ == "__main__":
    sys.exit(main())
