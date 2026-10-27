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
from datetime import date
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
WORKER_BASE = "https://stable-tour-feed.jvilla10214.workers.dev"
# GitHub Pages' own real base URL (same site index.html deploys to) — see
# PAGES_BASE's own usage in toc_html()/main() for why this exists at all.
PAGES_BASE = "https://jvilla10214.github.io/GiddyUpBets-command-center"
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

# A recap's "track" field is the raw lowercase track id (see
# readAllRecapIndexes() in workers/stable-tour-feed.js) — fine as a key, but
# "belmont"/"saratoga" shown as-is next to a recap date reads badly. Same
# map/same fix as ENTRIES_TRACK_LABEL in the Worker's own entry-alert email,
# which already does this lookup correctly; this script just hadn't been
# updated to match when the recap-origin tag was added here.
TRACK_LABEL = {
    "saratoga": "Saratoga", "belmont": "Belmont", "delmar": "Del Mar", "monmouth": "Monmouth",
    "york": "York", "ascot": "Ascot", "epsomdowns": "Epsom Downs", "newmarket": "Newmarket",
    "curragh": "Curragh", "longchamp": "Longchamp",
    "shatin": "Sha Tin", "happyvalley": "Happy Valley", "meydan": "Meydan",
    "churchilldowns": "Churchill Downs", "santaanita": "Santa Anita", "oaklawnpark": "Oaklawn Park",
    "keeneland": "Keeneland", "gulfstreampark": "Gulfstream Park", "colonialdowns": "Colonial Downs",
    "kentuckydowns": "Kentucky Downs", "ellispark": "Ellis Park", "fairgrounds": "Fair Grounds",
    "woodbine": "Woodbine", "parx": "Parx",
}

# Official stakes names, by date then race number — race numbers alone
# aren't unique across the two days (both have a "Race 6", a different race
# each day). Same map as BREEDERS_CUP_RACE_NAMES in workers/stable-tour-
# feed.js (ported there for the real drawn-card entry-alert email); kept
# here too so this one-time pre-entry send shows the same race names.
BREEDERS_CUP_RACE_NAMES = {
    "2026-10-30": {
        6: "Breeders' Cup Juvenile Turf Sprint",
        7: "Breeders' Cup Juvenile Fillies",
        8: "John Deere Breeders' Cup Juvenile Fillies Turf",
        9: "FanDuel Breeders' Cup Juvenile",
        10: "Brown Advisory Breeders' Cup Juvenile Turf",
    },
    "2026-10-31": {
        4: "Breeders' Cup Filly & Mare Sprint",
        5: "Prevagen Breeders' Cup Turf Sprint",
        6: "Breeders' Cup Dirt Mile",
        7: "Maker's Mark Breeders' Cup Filly & Mare Turf",
        8: "Cygames Breeders' Cup Sprint",
        9: "FanDuel Breeders' Cup Mile",
        10: "Longines Breeders' Cup Distaff",
        11: "Longines Breeders' Cup Turf",
        12: "Longines Breeders' Cup Classic",
    },
}

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


DATE_LABEL_RE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})$")


def format_date_label(date_str):
    """ISO date -> M/D/Y, matching formatEmailDateLabel() in
    workers/stable-tour-feed.js and the project's month/day/year convention
    for everything user-facing."""
    m = DATE_LABEL_RE.match(date_str or "")
    if not m:
        return date_str or "—"
    year, month, day = m.groups()
    return f"{int(month)}/{int(day)}/{year}"


# Note-age badge — same shape/position as the Worker's "NEW" badge on a
# quote ribbon (white pill, inline next to the QUOTE label), tiered by age
# instead of a single color. Thresholds match stableNoteAgeBadgeHtml() in
# index.html, so a quote reads the same age-wise in the UI and in email.
AGE_BADGE_COLORS = {"mild": "#a9a496", "caution": "#f0b429", "stale": "#e05252"}


def note_age_badge_html(date_str):
    m = DATE_LABEL_RE.match(date_str or "")
    if not m:
        return ""
    year, month, day = (int(x) for x in m.groups())
    days = (date.today() - date(year, month, day)).days
    if days < 122:
        return ""
    months = round(days / 30.4)
    tier = "mild" if days < 183 else "caution" if days < 274 else "stale"
    color = AGE_BADGE_COLORS[tier]
    return (
        f'<span style="display:inline-block; background:#ffffff; color:{color}; font-weight:700; '
        f'font-size:9px; letter-spacing:0.04em; padding:1px 6px; border-radius:8px; margin-left:7px; '
        f'vertical-align:middle;">{months} MO OLD</span>'
    )


def notes_for_horse(all_notes, tracked_trainers, horse_name):
    # normalize_horse_key strips the country suffix — the official entry
    # reads "Forever Young (JPN)" but every Stable Tour quote for that horse
    # is filed under the bare "Forever Young". Without stripping both sides
    # the same way (recaps_for_horse already did; this one didn't), every
    # foreign-bred horse (JPN/IRE/FR/GB/etc.) showed zero quotes in the real
    # Sunday digest despite the notes genuinely existing (confirmed real
    # 2026-10-26, caught via Forever Young specifically).
    key = normalize_horse_key(horse_name)
    matches = [n for n in all_notes if normalize_horse_key(n.get("horse")) == key]
    # Same rule the frontend's BC notes subsection uses: a trainer-less note
    # always shows; a note naming a trainer only shows once that trainer is
    # actually tracked.
    matches = [n for n in matches if not n.get("trainer") or n["trainer"] in tracked_trainers]
    matches.sort(key=lambda n: (n.get("date") or "", n.get("capturedAt") or ""), reverse=True)
    # Full history, not capped — user confirmed 2026-10-24 Gmail's clip
    # threshold is fine, this should show everything we have.
    return matches


# Recurring non-trainer, non-jockey podcast guests stored in the jockey
# field purely to reuse its existing "always show" display behavior (see
# write_episode_analyst_notes() in automation/podcast-quotes/write_notes.py)
# — same set as PODCAST_ANALYST_NAMES in index.html/workers/stable-tour-
# feed.js, kept here too so this script's own note cards don't mislabel him.
PODCAST_ANALYST_NAMES = {"David Aragona"}


def note_card_html(n):
    is_analyst = n.get("jockey") in PODCAST_ANALYST_NAMES
    role_icon = "&#127908;" if n.get("trainer") else "&#128202;" if is_analyst else "&#127943;"
    role_label = "Trainer" if n.get("trainer") else "Analyst" if is_analyst else "Jockey"
    speaker = n.get("trainer") or n.get("jockey") or ""
    source = n.get("source") or ("auto-imported" if n.get("autoImported") else "manual")
    quote_hue = NOTE_TYPE_RIBBON_COLORS["quote"]
    age_badge = note_age_badge_html(n.get("date"))
    return f"""
    <div style="border-radius:6px; overflow:hidden; margin:4px 0 8px;">
      <div style="background:{quote_hue}; color:#ffffff; font-family:Arial,Helvetica,sans-serif; font-weight:700; font-size:10.5px; letter-spacing:0.05em; padding:6px 12px;">{role_icon} QUOTE &mdash; {esc(format_date_label(n.get('date')))}{age_badge}</div>
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
        date_label = format_date_label(e.get("date"))
        origin_tag = f" &middot; {esc(TRACK_LABEL.get(e['track'], e['track']))}" if e.get("track") else ""
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


def race_anchor_id(race_num):
    return f"race-{race_num}"


def race_html(race, all_notes, tracked_trainers, recap_index, date_str):
    tag = f"RACE {race['num']} &middot; {esc(race['post'])} &middot; {esc(race['purse'])} {esc(race['cond'])} &middot; {esc(race['dist'])} {esc(race['surf'])}"
    race_name = BREEDERS_CUP_RACE_NAMES.get(date_str, {}).get(race["num"])
    race_name_html = (
        f'<div style="font-family:Georgia,\'Times New Roman\',serif; font-weight:700; font-size:16px; color:{THEME["accent"]}; margin-bottom:6px;">{esc(race_name)}</div>'
        if race_name else ""
    )
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
      <div id="{race_anchor_id(race['num'])}" style="padding:16px 30px; border-bottom:1px solid {THEME['hairline']};">
        {race_name_html}
        <span style="display:inline-block; font-family:Arial,Helvetica,sans-serif; font-weight:700; font-size:11px; letter-spacing:0.06em; background:{THEME['accent']}; color:#ffffff; padding:3px 9px; border-radius:3px; margin-bottom:10px;">{tag}</span>
        {''.join(horses_html)}
      </div>"""


def page_filename(day):
    return f"{day['date']}.html"


# Confirmed real 2026-10-27: even the "name" anchor trick doesn't actually
# make Gmail jump within the email body — Gmail (web and app) simply
# doesn't support in-message anchor navigation at all, a documented email-
# client limitation, not something fixable with different HTML. The real
# fix newsletter platforms use for exactly this is a "view in browser" page:
# link each race pill to a REAL hosted copy of this same email (same
# GitHub Pages site index.html already deploys to) with the race's anchor
# in the URL — clicking it from Gmail opens a real browser tab, where the
# anchor-scroll already confirmed to work correctly takes over. page_url is
# None while building the *hosted page itself* (it doesn't need to link to
# itself) and the real URL when building the actual *email*.
def toc_html(day, page_url=None):
    races = day["races"]
    if len(races) < 2:
        return ""
    pills = []
    for r in races:
        name = BREEDERS_CUP_RACE_NAMES.get(day["date"], {}).get(r["num"], "")
        href = f"{page_url}#{race_anchor_id(r['num'])}" if page_url else f"#{race_anchor_id(r['num'])}"
        pills.append(
            f'<a href="{esc(href)}" title="{esc(name)}" '
            f'style="display:inline-block; font-family:Arial,Helvetica,sans-serif; font-weight:700; font-size:11px; '
            f'color:{THEME["accent"]}; background:{THEME["hairline"]}; text-decoration:none; padding:3px 10px; '
            f'border-radius:10px; margin:2px 3px;">R{r["num"]}</a>'
        )
    note = (
        f'<div style="font-family:Arial,Helvetica,sans-serif; font-size:9.5px; color:{THEME["dim"]}; margin-top:6px;">'
        f"Opens the web version of this email, scrolled to that race &mdash; Gmail itself can't jump within a message.</div>"
        if page_url else ""
    )
    return f"""
    <div style="padding:10px 30px 14px; text-align:center; border-bottom:1px solid {THEME['hairline']};">
      <span style="display:block; font-family:Arial,Helvetica,sans-serif; font-weight:700; font-size:9px; letter-spacing:0.08em; text-transform:uppercase; color:{THEME['dim']}; margin-bottom:6px;">Jump to a race</span>
      {''.join(pills)}
      {note}
    </div>"""


def build_day_body(day, all_notes, tracked_trainers, recap_index, page_url=None):
    horse_count = sum(len(r["horses"]) for r in day["races"])
    races_html = "".join(race_html(r, all_notes, tracked_trainers, recap_index, day["date"]) for r in day["races"])
    return f"""
    <div style="background:{THEME['bg']}; color:{THEME['ink']}; font-family:Georgia,'Times New Roman',serif; max-width:640px; margin:0 auto;">
      <div style="padding:26px 30px 20px; text-align:center; border-bottom:3px double {THEME['accent']};">
        <div style="font-family:Arial,Helvetica,sans-serif; font-weight:700; font-size:22px; color:{THEME['accent']}; margin-bottom:6px;">GiddyUpQuotes &mdash; Breeders' Cup Pre-Entries</div>
        <div style="font-family:'Courier New',Courier,monospace; font-size:11px; color:{THEME['dim']};">Keeneland &middot; {esc(day['label'])} &middot; {horse_count} pre-entered horses &middot; PRE-ENTRIES &mdash; DRAW NOT YET MADE</div>
      </div>
      {toc_html(day, page_url)}
      {races_html}
    </div>"""


def build_day_email(day, all_notes, tracked_trainers, recap_index):
    horse_count = sum(len(r["horses"]) for r in day["races"])
    subject = f"GiddyUpQuotes — Breeders' Cup Pre-Entries — {day['label']} ({horse_count} horses, draw not yet made)"
    page_url = f"{PAGES_BASE}/bc-digest/{page_filename(day)}"
    html_body = build_day_body(day, all_notes, tracked_trainers, recap_index, page_url=page_url)
    return subject, html_body


def build_day_page(day, all_notes, tracked_trainers, recap_index):
    """The hosted 'view in browser' copy — same content as the email, just
    without its own page_url (no point linking to itself), wrapped as a
    real standalone document so a browser (not Gmail) renders it and the
    anchor-scroll toc_html() points at actually works."""
    body = build_day_body(day, all_notes, tracked_trainers, recap_index, page_url=None)
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GiddyUpQuotes — Breeders' Cup Pre-Entries — {esc(day['label'])}</title>
</head>
<body style="margin:0; padding:20px 0; background:{THEME['bg']};">
{body}
</body>
</html>"""


def main():
    bc_data = load_bc_data()
    data = fetch_url(f"{WORKER_BASE}/data")
    all_notes = data.get("notes", [])
    tracked_trainers = set(data.get("trainers", []))
    recap_index = fetch_url(f"{WORKER_BASE}/recap-index").get("byHorse", {})

    pages_dir = REPO_ROOT / "bc-digest"
    pages_dir.mkdir(exist_ok=True)

    for day in bc_data["days"]:
        page_html = build_day_page(day, all_notes, tracked_trainers, recap_index)
        (pages_dir / page_filename(day)).write_text(page_html, encoding="utf-8")
        print(f"{day['label']}: wrote {pages_dir / page_filename(day)}", flush=True)

    for day in bc_data["days"]:
        subject, html_body = build_day_email(day, all_notes, tracked_trainers, recap_index)
        result = fetch_url(f"{WORKER_BASE}/send-custom-email", method="POST", body={"subject": subject, "html": html_body})
        print(f"{day['label']}: sent -> {result}", flush=True)


if __name__ == "__main__":
    sys.exit(main())
